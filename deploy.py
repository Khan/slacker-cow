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
    subprocess.check_output(['docker', 'build',
                             '-t', 'gcr.io/slacker-cow/hubot',
                             '.'])
    subprocess.check_output(['gcloud', 'docker',
                             'push', 'gcr.io/slacker-cow/hubot'])


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
    pods = subprocess.check_output(['kubectl', 'get', 'pods'])
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


def deploy(current, new, slack_token, jenkins_api_token, jenkins_deploy_token,
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
        print(subprocess.check_output(
            ['kubectl', 'rolling-update', current,
             '-f', kube_desc.name]))
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
    deploy(current_version, new_version, slack_token, jenkins_api_token,
           jenkins_deploy_token)

if __name__ == '__main__':
    main()
