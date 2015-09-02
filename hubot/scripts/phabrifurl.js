// All this does is linkify Phabricator items.
export default robot => {
  robot.hear(/(?:^|\s)([DT]\d{2,})\b/, msg => {
    const phabID = msg.match[1];
    if (phabID === 'D20') {
      msg.send('Impressive roll, Padawan Sulu. Oh my.');
    } else {
      msg.send(`:phabricator: <https://phabricator.khanacademy.org/${phabID}|${phabID}>`);
    }
  });
};
