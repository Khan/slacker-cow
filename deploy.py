#!/usr/bin/env python
# -*- coding: utf-8; -*-

"""Automate deploying Slacker Cow updates.

This *only* handles automatically upgrading Slacker-Cow (i.e.
frontend-controller.template.json); it makes no attempt to handle updating all
of the other components, such as Redis and so on. But since those should rarely
(if ever) need to be altered, that's not a real concern, either.
"""

from __future__ import print_function

import os
import re
import StringIO
import sys
import subprocess
import tempfile

# Location of the kubectl template
FRONTEND_TEMPLATE = 'kubecfg/frontend-controller.template.json'
# String to replace with the new version stamp
VERSION_REPLACEMENT = 'XXX-REPLACE-WITH-NEW-VERSION-XXX'
# String to replace with the Slack API token
SLACK_REPLACEMENT = 'XXX-REPLACE-WITH-SLACK-TOKEN-XXX'
# Path to file containing the Slack API token to use
SLACK_TOKEN_FILE = '.slack_token'
# String to replace with the Jenkins API token
JENKINS_API_REPLACEMENT = 'XXX-REPLACE-WITH-JENKINS-API-TOKEN-XXX'
# Path to file containing the Jenkins API token to use
JENKINS_API_TOKEN_FILE = '.jenkins_api_token'
# Regex to find the current version from kubectl's output
POD_ID_MATCH = re.compile('frontend-v\d+-[^\s]+', re.MULTILINE)


def rebuild_image():
    run_command(['docker', 'build', '-t', 'gcr.io/slacker-cow/hubot', '.'])
    run_command(['gcloud', 'docker', 'push', 'gcr.io/slacker-cow/hubot'])


def get_version(s):
    """Return the actual version from a pod string.

    kubectl, when give a string like foobarbaz, actually generates
    a version called foobarbaz-<random stuff here>. This rips that
    off.
    """
    return s.rsplit('-', 1)[0]


def get_pod_id():
    """Return the current pod ID running on Google Cloud.

    For a given version with the name ABC, Google Cloud pod
    IDs look like ABC-<random string>; this function will include
    that.
    """
    pods = run_command(['kubectl', 'get', 'pods'])
    return POD_ID_MATCH.search(pods).group(0)


def increment_version(current_version):
    """Return the next version name."""
    prefix, version = current_version.split('-')
    return '%s-v%s' % (prefix, int(version[1:]) + 1)


def get_secret(filename, passphrase_id):
    if not os.path.exists(filename):
        print(u'Please create a “%s” file with secret %s in it.'
              % (filename, passphrase_id),
              file=sys.stderr)
        exit(1)
    return open(filename).read().strip()


def run_command(command):
    """Run a subprocess command, but echoing as it goes.

    Returns all of the command output."""
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    output = StringIO.StringIO()
    while True:
        next_line = process.stdout.readline()
        if next_line == '' and process.poll() is not None:
            break
        if next_line:
            print(next_line.strip())
            output.write(next_line)
    rc = process.poll()
    output = output.getvalue()
    if rc:
        raise subprocess.CalledProcessError(returncode=rc, cmd=command,
                                            output=output)
    return output


def deploy(current, new, slack_token, jenkins_api_token,
           delete_desc_file=True):
    """Deploy a new version of slacker-cow."""
    template = open(FRONTEND_TEMPLATE, 'rb').read()
    template = template.replace(VERSION_REPLACEMENT, new)
    template = template.replace(SLACK_REPLACEMENT, slack_token)
    template = template.replace(JENKINS_API_REPLACEMENT, jenkins_api_token)
    with tempfile.NamedTemporaryFile(suffix='.json', delete=False)\
            as kube_desc:
        kube_desc.write(template)
    try:
        run_command(['kubectl',
                     'rolling-update', current, '-f', kube_desc.name])
    finally:
        if delete_desc_file:
            os.unlink(kube_desc.name)


def main():
    rebuild_image()
    pod_id = get_pod_id()
    current_version = get_version(pod_id)
    new_version = increment_version(current_version)
    slack_token = get_secret(SLACK_TOKEN_FILE, "K88")
    jenkins_api_token = get_secret(JENKINS_API_TOKEN_FILE, "K92")
    deploy(current_version, new_version, slack_token, jenkins_api_token)

if __name__ == '__main__':
    main()
