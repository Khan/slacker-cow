FROM node:0.12

RUN npm install -g hubot coffee-script
COPY hubot /hubot
RUN cd hubot && npm install

CMD cd hubot && bin/hubot -a slack
