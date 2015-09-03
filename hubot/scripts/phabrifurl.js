// All this does is linkify Phabricator items.
export default robot => {
  robot.hear(/(?:^|\s)([DT]\d{2,})\b/, msg => {
    const phabID = msg.match[1];
    if (phabID === 'D20') {
      msg.send('Impressive roll, Padawan Sulu. Oh my.');
    } else {
      const msgData = {
          sender: "Phabricator Fox",
          icon_emoji: ":fox:",
          channel: msg.envelope.room,
        text: `:phabricator: <https://phabricator.khanacademy.org/${phabID}|${phabID}>`
      };
      robot.adapter.customMessage(msgData);
    }
  });
};
