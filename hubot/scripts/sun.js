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

import "https";
import "querystring";


// The room to listen to deployment commands in. For safety reasons,
// culture cow will only listen in this room by default.
const DEPLOYMENT_ROOM = process.env.DEPLOY_ROOM || "#bot-testing";

// Whether to run in DEBUG mode.  In DEBUG mode, culture cow will not
// actually post commands to Jenkins, nor will it only honor Jenkins
// state commands that come from the actual Jenkins, allowing for
// easier debugging
const DEBUG = !!process.env.HUBOT_DEBUG;

// This is a list of currently allowed deploy commands and the
// post-data to send to jenkins to have it do that command.  (The
// exception is 'deploy', where the post-data is determined from the
// hubot message itself.)  (NOTE: for 'cancel' this holds a GET url,
// not POST data.)  The list of allowed deploy commands changes as we
// make our way through the deploy pipeline.
var gNextPipelineCommands = {
  // When we start out, the only pipeline step to do is the first one.
  deploy: true,
  setDefault: null,
  abort: null,       // used to cancel *in between* individual jobs
  cancel: null,      // used to cancel a running job
  finish: null
};

// Resets gNextPipelineCommands to indicate what commands are now
// acceptable (based on the current state of the pipeline).
function setNextPipelineCommands(newData) {
  gNextPipelineCommands = {
    deploy: newData.deploy || false,
    setDefault: newData.setDefault || null,
    abort: newData.abort || null,
    cancel: newData.cancel || null,
    finish: newData.finish || null
  };
}


function onHttpError(res) {
  const errorMessage = ("Jenkins won't listen to me.  " +
  "Go talk to it yourself.");
  // The error message usually comes after another message.
  // Wait a second to encourage to put the messages in the
  // right order.
  setTimeout(() => res.reply(errorMessage), 1000);

  // Also log the error to /var/log/upstart/culture-cow.*.  (Recipe from
  // http://nodejs.org/api/http.html#http_http_request_options_callback).
  console.error('ERROR TALKING TO JENKINS:');
  console.error('   Status: ' + res.statusCode);
  console.error('   Headers: ' + JSON.stringify(res.headers));
  res.setEncoding('utf8');
  res.on('data', chunk => {
    console.error('   Body: ' + chunk);
  });
}

function wrongRoom(msg) {
  msg.reply("How dare you approach me outside my temple?!");
}

function wrongPipelineStep(msg, badStep) {
  msg.reply("I'm not going to " + badStep + " -- it's not time for that. " +
    "If you disagree, bring it up with Jenkins.");
}


// postData is a url-encoded string, suitable for sending in the http body.
function runOnJenkins(msg, postData, message) {

  const options = {
    hostname: 'jenkins.khanacademy.org',
    port: 443,
    path: '/buildByToken/buildWithParameters',
    method: 'POST'
  };
  if (postData.indexOf('&') === -1) {       // no parameters except job=...
    options.path = '/buildByToken/build';
  }

  // Add some invariants to the post data.  (JENKINS_DEPLOY_TOKEN is
  // under our control and we know it's url-escape safe.)
  postData = postData + ("&token=" + process.env.JENKINS_DEPLOY_TOKEN +
    "&cause=Sun+Wukong");

  // Tell readers what we're doing.
  msg.reply((DEBUG ? "DEBUG :: " : "") + message);

  if (DEBUG) {
    console.log(options);
    return;
  }

  const req = https.request(options, res => {
    // Jenkins apparently now sometimes returns 201s for success, so allow
    // that.  We don't want to allow 3xx because that means that whatever
    // we were trying to do wasn't done.
    if (res.statusCode > 299) {
      onHttpError(res);
    }
  });

  // write data to request body
  req.setHeader('Content-length', postData.length);
  req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
  req.write(postData);
  req.end();
}


function handlePing(msg) {
  msg.reply("I AM THE MONKEY KING!");
}

function handleDeploy(msg) {
  if (!gNextPipelineCommands.deploy && !msg.match[2]) {
    msg.reply("I think there's a deploy already going on.  If that's " +
      "not the case, or you want to start a deploy anyway, say " +
      "'sun, deploy " + msg.match[1] + ", dagnabit'.");
    return;
  }

  const deployBranch = msg.match[1];
  const caller = msg.envelope.user.mention_name;
  const postDataMap = {
    "job": "deploy-via-multijob",
    "GIT_REVISION": deployBranch,
    // In theory this should be an email address but we actually
    // only care about names for the script, so we make up
    // a 'fake' email that yields our name.
    "BUILD_USER_ID_FROM_SCRIPT": caller + "@khanacademy.org"
  };
  const postData = querystring.stringify(postDataMap);

  runOnJenkins(msg, postData,
    "Telling Jenkins to deploy branch " + deployBranch + ".");
}

function handleSetDefault(msg) {
  if (!gNextPipelineCommands.setDefault) {
    wrongPipelineStep(msg, 'set-default');
    return;
  }
  runOnJenkins(msg, gNextPipelineCommands.setDefault,
    "Telling Jenkins to set default.");
}

function handleAbort(msg) {
  if (gNextPipelineCommands.cancel) {
    runOnJenkins(msg, gNextPipelineCommands.cancel,
      "Telling Jenkins to cancel this deploy");
    return;
  }

  if (!gNextPipelineCommands.abort) {
    wrongPipelineStep(msg, 'abort');
    return;
  }
  runOnJenkins(msg, gNextPipelineCommands.abort,
    "Telling Jenkins to abort this deploy.");
}

function handleFinish(msg) {
  if (!gNextPipelineCommands.abort) {
    wrongPipelineStep(msg, 'finish');
    return;
  }
  runOnJenkins(msg, gNextPipelineCommands.finish,
    "Telling Jenkins to finish this deploy!");
}

function handleRollback(msg) {
  msg.reply("Are you currently doing a deploy?  Say <b>sun, abort</b> " +
    "instead.  Do you want to roll back the production servers " +
    "because you noticed some problems with them after their " +
    "deploy was finished?  Say <b>sun, emergency rollback</b>.");
}

function handleEmergencyRollback(msg) {
  const jobname = '---EMERGENCY-ROLLBACK---';
  runOnJenkins(msg, 'job=' + querystring.escape(jobname),
    "Telling Jenkins to roll back the live site to a safe " +
    "version");
}


function _appendJobname(jobname, otherPostParams) {
  return otherPostParams + '&job=' + querystring.escape(jobname);
}

function handleAfterStart(msg) {
  setNextPipelineCommands({"cancel": msg.match[1]});
}

function handleAfterDeploy(msg) {
  setNextPipelineCommands(
    {
      "setDefault": _appendJobname(msg.match[1], msg.match[2]),
      "abort": _appendJobname(msg.match[3], msg.match[4])
    });
}

function handleAfterSetDefault(msg) {
  setNextPipelineCommands({"cancel": msg.match[1]});
}

function handleFailedSetDefault(msg) {
    // In the case of a failed set-default, the only thing Sun knows how to do
    // is abort and roll back.  If someone wants to manually set default,
    // they'll have to finish up on their own (Mr. Gorilla posts a link).
    setNextPipelineCommands({"abort": msg.match[1]});
}

function handleAfterMonitoring(msg) {
  setNextPipelineCommands(
    {
      "finish": _appendJobname(msg.match[1], msg.match[2]),
      "abort": _appendJobname(msg.match[3], msg.match[4])
    });
}

function handleDeployDone(msg) {
  // The old deploy is over, time to start a new one!
  setNextPipelineCommands({"deploy": true});
}


// fn takes a robot object and a hubot message object.
function hearInDeployRoom(robot, regexp, fn) {
  robot.hear(regexp, msg => {
    if (!DEBUG && msg.envelope.room !== DEPLOYMENT_ROOM) {
      wrongRoom(msg);
      return;
    }

    fn(msg);
  });
}

export default robot => {
  hearInDeployRoom(robot, /^sun,\s+ping$/i, handlePing);

  // These are the user-typed commands we listen for.
  hearInDeployRoom(robot, /^sun,\s+deploy\s+(?:branch\s+)?([^,]*)(, dagnabit)?$/i, handleDeploy);
  hearInDeployRoom(robot, /^sun,\s+set.default$/i, handleSetDefault);
  hearInDeployRoom(robot, /^sun,\s+abort.*$/i, handleAbort);
  hearInDeployRoom(robot, /^sun,\s+finish.*$/i, handleFinish);
  // Does an emergency rollback, outside the deploy process
  hearInDeployRoom(robot, /^sun,\s+rollback.*$/i, handleRollback);
  hearInDeployRoom(robot, /^sun,\s+emergency rollback.*$/i,
    handleEmergencyRollback);

  // These are the Jenkins-emitted messages we listen for.
  hearInDeployRoom(robot, /\(failed\) abort: https:\/\/jenkins.khanacademy.org(.*\/stop)$/, handleAfterStart);
  hearInDeployRoom(robot, /\(successful\) set it as default: type 'sun, set default' or visit https:\/\/jenkins.khanacademy.org\/job\/([^\/]*)\/parambuild\?([^\n]*)\n\(failed\) abort the deploy: type 'sun, abort' or visit https:\/\/jenkins.khanacademy.org\/job\/([^\/]*)\/parambuild\?(.*)/, handleAfterDeploy);
  hearInDeployRoom(robot, /\(failed\) abort and rollback: https:\/\/jenkins.khanacademy.org(.*\/stop)$/, handleAfterSetDefault);
  hearInDeployRoom(robot, /set-default failed.*\(failed\) abort and roll back https:\/\/jenkins.khanacademy.org(.*rollback.*aborted)$/, handleFailedSetDefault);
  hearInDeployRoom(robot, /\(successful\) finish up: type 'sun, finish up' or visit https:\/\/jenkins.khanacademy.org\/job\/([^\/]*)\/parambuild\?([^\n]*)\n\(failed\) abort and roll back: type 'sun, abort' or visit https:\/\/jenkins.khanacademy.org\/job\/([^\/]*)\/parambuild\?(.*)/, handleAfterMonitoring);
  hearInDeployRoom(robot, /Deploy of .* (failed[:.]|succeeded!)/, handleDeployDone);
  hearInDeployRoom(robot, /has manually released the deploy lock/, handleDeployDone);
};
