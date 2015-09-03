/**
 * Description:
 *   Send prod-deploy commands to jenkins.
 *
 * Dependencies:
 *   None
 *
 * Configuration:
 *   The JENKINS_DEPLOY_TOKEN environment variables must be set.
 *   The HUBOT_DEBUG flag can be set if you want to debug this
 *   module without risking talking to Jenkins.
 *
 * Commands:
 *   sun, deploy <branch foo> - deploy a particular branch to production
 *   sun, set default - after a deploy succeeds, sets the deploy as default
 *   sun, abort - abort a deploy (at any point during the process)
 *   sun, finish - do the last step in deploy, to merge with master and let the next person deploy
 *   sun, rollback - get a note to use "sun, emergency rollback" instead
 *   sun, emergency rollback - does an emergency rollback outside of deploy process
 *
 * Author:
 *   csilvers
 */

import https from "https";
import Q from "q";
import querystring from "querystring";


// The room to listen to deployment commands in. For safety reasons,
// culture cow will only listen in this room by default.
const DEPLOYMENT_ROOM = process.env.DEPLOY_ROOM || "#bot-testing";

// Whether to run in DEBUG mode.  In DEBUG mode, culture cow will not
// actually post commands to Jenkins, nor will it only honor Jenkins
// state commands that come from the actual Jenkins, allowing for
// easier debugging
const DEBUG = !!process.env.HUBOT_DEBUG;


function replyAsSun(msg, reply) {
  if (!msg.robot.adapter.customMessage) {
    // Allow for testing in the shell, where we don't have our fancy adapter
    msg.reply(reply);
  } else {
    const msgData = {
      username: "Sun Wukong",
      icon_emoji: ":monkey_face:",
      channel: msg.envelope.room,
      text: "<@" + msg.envelope.user.name + "> " + reply,
    };
    msg.robot.adapter.customMessage(msgData);
  }
}


function onHttpError(msg, res) {
  const errorMessage = ("Jenkins won't listen to me.  " +
  "Go talk to it yourself.");
  // The error message usually comes after another message.
  // Wait a second to encourage to put the messages in the
  // right order.
  setTimeout(() => replyAsSun(msg, errorMessage), 1000);

  // Also log the error to /var/log/upstart/culture-cow.*.  (Recipe from
  // http://nodejs.org/api/http.html#http_http_request_options_callback).
  if (res.statusCode) {
      console.error('ERROR TALKING TO JENKINS:');
      console.error('   Status: ' + res.statusCode);
      console.error('   Headers: ' + JSON.stringify(res.headers));
      res.setEncoding('utf8');
      res.on('data', chunk => {
        console.error('   Body: ' + chunk);
      });
  } else {
      console.error(res.stack)
      console.error(res);
  }
}

function wrongRoom(msg) {
  replyAsSun(msg, "How dare you approach me outside my temple?!");
}

/**
 * Return whether the proposed step is valid.
 */
function pipelineStepIsValid(deployState, step) {
  return (deployState.POSSIBLE_NEXT_STEPS &&
          deployState.POSSIBLE_NEXT_STEPS.indexOf(step) !== -1);
};

function wrongPipelineStep(msg, badStep) {
  replyAsSun(msg, "I'm not going to " + badStep + " -- it's not time for " +
             "that.  If you disagree, bring it up with Jenkins.");
}

/**
 * Get a promise for a URL or node http options object.
 */
function httpsGet(url) {
  const deferred = Q.defer();
  const req = https.get(url, deferred.resolve);
  req.on('error', deferred.reject);
  return deferred.promise;
};

/**
 * Get the current state of the deploy from Jenkins.
 *
 * Returns a promise for the state.
 */
function getDeployState() {
    return httpsGet("https://jenkins.khanacademy.org/deploy-state.json");
};

/**
 * Returns a promise for the current job ID if one is running, or false if not.
 */
function jenkinsJobStatus(jobName) {
  return httpsGet({
    hostname: 'jenkins.khanacademy.org',
    port: 443,
    path: '/job/' + jobName + '/lastBuild/api/json',
    auth: 'jenkins@khanacademy.org:' + process.env.JENKINS_API_TOKEN
  }).then(res => {
    const deferred = Q.defer();
    if (res.statusCode > 299) {
      deferred.reject(res);
    } else {
      let data = '';
      res.on('data', chunk => {data += chunk;});
      res.on('end', () => {
        data = JSON.parse(data);
        if (data.building === undefined) {
          deferred.reject(res);
        } else if (data.building && !data.number) {
          deferred.reject(res);
        } else if (data.building) {
          deferred.resolve(data.number);
        } else {
          deferred.resolve(null);
        }
      });
    }
    return deferred.promise;
  });
};

/**
 * Get the current running jobs from Jenkins.
 *
 * We check the three jobs deploy-via-multijob, deploy-set-default, and
 * deploy-finish.
 *
 * Returns a promise for an object with two keys, jobName (string) and jobId
 * (number), for the currently running job, or null if there is no job running.
 *
 * If, somehow, multiple such jobs are running, return the first one.  This
 * shouldn't happen.
 */
function getRunningJob() {
  const jobs = ['deploy-via-multijob', 'deploy-set-default', 'deploy-finish'];
  const result = Q.all(jobs.map(jenkinsJobStatus))
  .then(jobIds => {
    // `jobIds` is an array of jenkins job IDs corresponding to the names in
    // `jobs` (or null if there is none).  We want to find the first non-null
    // ID, along with the name to which it corresponds.
    const runningIndex = jobIds.findIndex((id, index) => id);
    return {
        jobName: jobs[runningIndex],
        jobId: jobIds[runningIndex],
    };
  });
  return result;
};

// postData is an object, which we will encode and post to either
// /job/<job>/build or /job/<job>/buildWithParameters, as appropriate.
function runJobOnJenkins(msg, jobName, postData, message) {
  let path;
  if (Object.keys(postData).length === 0) {  // no parameters
    path = `/job/${jobName}/build`;
  } else {
    path = `/job/${jobName}/buildWithParameters`;
  }
  
  runOnJenkins(msg, path, postData, message);
};


function cancelJobOnJenkins(msg, jobName, jobId, message) {
  const path = `/job/${jobName}/${jobId}/stop`;
  runOnJenkins(msg, path, {}, message, true);
};


// path should be the URL path; postData should be an object which we will
// encode.  If allowRedirect is falsy, we will consider a 3xx response an
// error.  If allowRedirect is truthy, we will consider a 3xx response a
// success.  (This is because a 302, for instance, might mean that we need to
// follow a redirect to do the thing we want, or it might mean that we were
// successful and are now getting redirected to a new page.)
function runOnJenkins(msg, path, postData, message, allowRedirect) {
  const options = {
    hostname: 'jenkins.khanacademy.org',
    port: 443,
    method: 'POST',
    path: path,
    auth: 'jenkins@khanacademy.org:' + process.env.JENKINS_API_TOKEN
  };

  postData = querystring.stringify(postData);

  // Tell readers what we're doing.
  replyAsSun(msg, (DEBUG ? "DEBUG :: " : "") + message);

  if (DEBUG) {
    console.log(options);
    return;
  }

  const req = https.request(options, res => {
    // Jenkins apparently now sometimes returns 201s for success, so allow
    // that.  We don't want to allow 3xx because that means that whatever
    // we were trying to do wasn't done.
    if ((!allowRedirect && res.statusCode > 299) || res.statusCode > 399) {
      onHttpError(msg, res);
    }
  });

  // write data to request body
  req.setHeader('Content-length', postData.length);
  req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
  req.write(postData);
  req.end();
}


function handlePing(msg, deployState) {
  replyAsSun(msg, "I AM THE MONKEY KING!");
}


function handleState(msg, deployState) {
  const prettyState = JSON.stringify(deployState, null, 2);
  getRunningJob().then(job => {
    const prettyRunningJob = JSON.stringify(job, null, 2);
    replyAsSun(msg, "Here's the state of the deploy: ```" +
               `\n${prettyRunningJob}\n\n${prettyState}\n` + "```");
  })
  .catch(err => {
    // If anywhere along the line we got an error, say so.
    onHttpError(msg, err);
  });
};

function handleDeploy(msg, deployState) {
  if (deployState.POSSIBLE_NEXT_STEPS) {
    replyAsSun(msg, "I think there's a deploy already going on.  If that's " +
      "not the case, or you want to start a deploy anyway,\n:speech_balloon: " +
      "_“sun, deploy " + msg.match[1] + ", dagnabit”_.");
    return;
  }

  const deployBranch = msg.match[1];
  const caller = msg.envelope.user.name;
  const postData = {
    "GIT_REVISION": deployBranch,
    // In theory this should be an email address but we actually
    // only care about names for the script, so we make up
    // a 'fake' email that yields our name.
    "BUILD_USER_ID_FROM_SCRIPT": caller + "@khanacademy.org"
  };

  runJobOnJenkins(msg, 'deploy-via-multijob', postData,
    "Telling Jenkins to deploy branch `" + deployBranch + "`.");
}

function handleSetDefault(msg, deployState) {
  if (!pipelineStepIsValid(deployState, 'set-default')) {
    wrongPipelineStep(msg, 'set-default');
    return;
  }
  const postData = {
    'TOKEN': deployState.TOKEN
  };
  runJobOnJenkins(msg, 'deploy-set-default', postData,
                  "Telling Jenkins to set `" + deployState.VERSION_NAME +
                  "` as the default.");
}

function handleAbort(msg, deployState) {
  getRunningJob().then(runningJob => {
    if (runningJob.jobName) {
      // There's a job running, so we should probably cancel it.
      if (runningJob.jobName === 'deploy-finish') {
        // We shouldn't cancel a deploy-finish.  If we need to roll
        // back, we now need to do an emergency rollback; otherwise we
        // should just let it finish and then do our thing.
        replyAsSun(msg, "I think there's currently a deploy-finish job " +
                   "running.  If you need to roll back, you will " +
                   "need to do an emergency rollback (:speech_balloon: " +
                   "_“sun, emergency rollback”_).  If not, just let it " +
                   "finish, or <https://jenkins.khanacademy.org/job/" + 
                   "deploy-finish/" + runningJob.jobId + "|check what it's" +
                   "doing> yourself.")
      } else {
        // Otherwise, cancel the job.
        cancelJobOnJenkins(msg, runningJob.jobName, runningJob.jobId,
                           "Telling Jenkins to cancel " +
                           runningJob.jobName +
                           " #" + runningJob.jobId + ".");
      }
    } else if (!deployState.POSSIBLE_NEXT_STEPS) {
      // If no deploy is in progress, we had better not abort.
      replyAsSun(msg, "I don't think there's a deploy going.  If you need " +
                 "to roll back the production servers because you noticed " +
                 "some problems after a deploy finished, :speech_balloon: " +
                 "_“sun, emergency rollback”_.  If you think there's a " +
                 "deploy going, then I'm confused and you'll have to talk " +
                 "to Jenkins yourself.")
    } else {
      // Otherwise, we're between jobs in a deploy, and we should determine
      // from the deploy state what to do.
      const postData = {
        'TOKEN': deployState.TOKEN,
        'WHY': 'aborted'
      };
      let response;
      if (pipelineStepIsValid(deployState, 'set-default')) {
        // If no build is running, and we could set default, we can just as
        // easily just give up
        postData.STATUS = 'failure';
        response = 'abort';
      } else {
        // Otherwise, we'd better roll back.
        postData.STATUS = 'rollback';
        postData.ROLLBACK_TO = deployState.ROLLBACK_TO;
        response = 'abort and roll back';
      }
      runJobOnJenkins(msg, 'deploy-finish', postData,
                      "Telling Jenkins to " + response + " this deploy.");
    }
  })
  .catch(err => {
    // If anywhere along the line we got an error, say so.
    onHttpError(msg, err);
  });
};

function handleFinish(msg, deployState) {
  if (!pipelineStepIsValid(deployState, 'finish-with-success')) {
    wrongPipelineStep(msg, 'finish-with-success');
    return;
  }
  let postData = {
    'TOKEN': deployState.TOKEN,
    'STATUS': 'success'
  };
  runJobOnJenkins(msg, 'deploy-finish', postData,
                  "Telling Jenkins to finish this deploy!");
};

function handleRollback(msg, deployState) {
  replyAsSun(msg, "Are you currently doing a deploy?\n:speech_balloon: " +
             "_“sun, abort”_\nDo you want to roll back the production " +
             "servers because you noticed some problems with them after " +
             "their deploy was finished?\n:speech_balloon: " +
             "_“sun, emergency rollback”_.");
}

function handleEmergencyRollback(msg, deployState) {
  const jobname = '---EMERGENCY-ROLLBACK---';
  runJobOnJenkins(msg, jobname, {},
    "Telling Jenkins to roll back the live site to a safe " +
    "version");
}

// fn takes a robot object and the deploy state.
function hearInDeployRoom(robot, regexp, fn) {
  robot.hear(regexp, msg => {
    if (!DEBUG && msg.envelope.room !== DEPLOYMENT_ROOM) {
      wrongRoom(msg);
      return;
    }

    getDeployState()
    .then(res => {
      const deferred = Q.defer();
      if (res.statusCode === 404) {
        deferred.resolve({});
      } else if (res.statusCode > 299) {
        deferred.reject(res);
      } else {
        let data = '';
        res.on('data', chunk => {data += chunk;});
        res.on('end', () => deferred.resolve(JSON.parse(data)));
      }
      return deferred.promise;
    })
    .then(state => fn(msg, state))
    .catch(err => onHttpError(msg, err));
  });
}

export default robot => {
  hearInDeployRoom(robot, /^sun,\s+ping$/i, handlePing);
  hearInDeployRoom(robot, /^sun,\s+state$/i, handleState);

  // These are the user-typed commands we listen for.
  hearInDeployRoom(robot, /^sun,\s+deploy\s+(?:branch\s+)?([^,]*)(, dagnabit)?$/i, handleDeploy);
  hearInDeployRoom(robot, /^sun,\s+set.default$/i, handleSetDefault);
  hearInDeployRoom(robot, /^sun,\s+abort.*$/i, handleAbort);
  hearInDeployRoom(robot, /^sun,\s+finish.*$/i, handleFinish);
  // Does an emergency rollback, outside the deploy process
  hearInDeployRoom(robot, /^sun,\s+rollback.*$/i, handleRollback);
  hearInDeployRoom(robot, /^sun,\s+emergency rollback.*$/i,
    handleEmergencyRollback);
};
