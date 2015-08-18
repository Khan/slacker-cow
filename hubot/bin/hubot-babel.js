#!/usr/bin/env node

require('babel/register');
require('coffee-script/register');

var path = require('path');
var fs = require('fs');
var coffeeScript = require('coffee-script');

var hubot = path.join(process.cwd(), 'node_modules', '.bin', 'hubot');

fs.readFile(hubot, function(err, file) {
  coffeeScript.run(file.toString(), { filename: hubot });
});
