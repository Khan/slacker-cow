FROM nodejs:0.12

RUN npm install -g hubot coffee-script
COPY hubot /hubot
RUN cd hubot && npm install hubot-diagnostics \
    hubot-help hubot-redis-brain hubot-slack --save && npm install

CMD cd hubot && bin/hubot
