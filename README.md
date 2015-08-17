# Slacker Cow :cow:
> Hubot instance for Khan Academy, Slack Edition.

## What it means to be Slacker Cow

1. Slacker Cow provides a steady drip of Khan Academy culture, straight into
Slack's veins.

2. If at any point Slacker Cow acts like an annoying robot by decreasing the
signal:noise ratio in our Slack rooms, it will be turned into delicious
hamburgers. :hamburger:

## Can I add more culture magic?

Absolutely. Modify `scripts/culture.js` (or whatever else you want). Just abide
by the two rules of Slacker Cow above.

Also note that since the [Slack API] is _much_ more robust than Hipchat was, you
may prefer to make something using that directly.

[Slack API]: https://api.slack.com

## Differences from Culture Cow

Culture Cow communicated via XMPP for Hubot, but used a custom HTTP adapter
to send formatted messages (`fancyMessage`) back separately via the HipChat API.

The Slack Hubot adapter uses their realtime API, and should support formatting.

To make nicely formatted Slack messages, see the following:
- https://api.slack.com/docs/formatting
- https://api.slack.com/docs/attachments

Discussion of how to send attachments via hubot-slack:
- https://github.com/slackhq/hubot-slack/issues/170

## Making a deploy

### Prerequisites

- Set up your gcloud environment as [per instructions]. (Note that you can use
`brew cask install google-cloud-sdk` instead of their installer, though.)

[per instructions]: https://cloud.google.com/container-engine/docs/before-you-begin#install_the_gcloud_command_line_interface
1. Install vagrant, virtualbox, and docker-machine:
  ```
  brew cask install vagrant virtualbox
  brew install docker-machine
  docker-machine create --driver virtualbox khan
  ```
- make changes
- build the container with `docker build -t gcr.io/slacker-cow/hubot .`
- push the container with `gcloud docker push gcr.io/slacker-cow/hubot`
- edit `kubecfg/frontend-controller.json`:
  1. increment `frontend-v[x]` to a higher number wherever you see it
  2. change `XXX-REPLACE-ME-WITH-SLACK-TOKEN` to the correct token
- run `kubectl rolling-update frontend-v[x] -f kubecfg/frontend-controller.json`
  where v[x] is the old version
- that's it!
