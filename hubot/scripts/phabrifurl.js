// All this does is linkify Phabricator items.
export default robot => {
  robot.hear(/\b(D\d+)\b/, msg => {
    if (msg.match[1] === 'D20') {
      msg.send('Impressive roll, Padawan Sulu. Oh my.');
    } else {
      msg.send(`https://phabricator.khanacademy.org/${msg.match[1]}`);
    }
  });
};
