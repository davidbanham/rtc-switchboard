/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('rtc-switchboard');
var FastMap = require('collections/fast-map');
var through = require('through');
var Room = require('./room');
var util = require('util');
var jsonparse = require('cog/jsonparse');

var baseHandlers = {
  announce: require('./handlers/announce')
};

/**
  ### ConnectionManager(primus, opts)

  The `ConnectionManager` is used to route messages from one peer to another.
  When a peer announces itself to the signalling server, if it has specified
  a room, then general messages will only be routed to other peers in the
  same room.

  An exeption to this case is `/to` messages which are routed directly to
  the specified peer.
**/
function ConnectionManager(primus, opts) {
  var handlers;

  if (! (this instanceof ConnectionManager)) {
    return new ConnectionManager();
  }

  // inherited
  EventEmitter.call(this);

  // save a reference to primus
  this.primus = primus;

  // create a rooms container
  this.rooms = {};

  // initialise the peer lookups
  this.sparks = new FastMap();

  // initialise the handlers
  handlers = this.handlers = (opts || {}).handlers || {};

  // add the base handlers if not specifically defined
  Object.keys(baseHandlers).forEach(function(name) {
    if (! handlers[name]) {
      handlers[name] = baseHandlers[name];
    }
  });

  // when peers are leaving, ensure cleanup
  this.on('leave', this._cleanupPeer.bind(this));
}

util.inherits(ConnectionManager, EventEmitter);
module.exports = ConnectionManager;

/**
  #### connect(spark)

  Return a [through](https://github.com/dominictarr/through) stream for the
  spark that we can pipe the incoming data from the spark into to be handled
  correctly.
**/
ConnectionManager.prototype.connect = function(spark) {
  var handlers = this.handlers;
  var mgr = this;

  // initialise the spark scope to primus
  spark.scope = this.primus;
  debug('new connection: ' + spark.id);

  function write(data, target) {
    var command;
    var handler;
    var targetId;
    var preventSend = false;
    var parts;

    // if we have string data then preprocess
    if (typeof data == 'string' || (data instanceof String)) {
      if (data.charAt(0) === '/') {
        // initialise the command name
        command = data.slice(1, data.indexOf('|', 1)).toLowerCase();

        // get the payload
        parts = data.slice(command.length + 2).split('|').map(jsonparse);

        // if we have a to command, and no designated target
        if (command === 'to') {
          // get the target
          targetId = parts[0];
          target = mgr.sparks.get(targetId);

          // if the target is unknown, refuse to send
          if (! target) {
            return false;
          }
        }
      }
    }

    // check if we have a handler for the current command
    handler = command && handlers[command];

    // if we have a handler, the invoke
    if (typeof handler == 'function') {
      preventSend = !!handler(mgr, spark, data, parts);
    }

    // debug('got message: ' + data + ', command: ' + command + ', prevent send: ' + preventSend, payload);

    // trigger a command event
    if (command) {
      mgr.emit(command, parts[parts.length - 1]);
    }

    // if we are preventing send, then return
    if (preventSend) {
      return false;
    }

    if (target) {
      debug('/to ' + targetId + ', data: ' + data);
      target.write(data);
    }
    else {
      debug('writing data to spark scope: ', data);
      spark.scope.write(data, spark);
    }
  }

  function end() {
    debug('spark ended, disconnecting');

    // invoke the leave action if part of a room
    if (spark.scope && typeof spark.scope.leave == 'function') {
      spark.scope.leave(spark);
    }
  }

  debug('spark connecting');
  return through(write, end);
};

/**
  #### createSocket(url)

  Create a websocket client connection the underlying primus server.
**/
ConnectionManager.prototype.createSocket = function(url) {
  return new this.primus.Socket(url);
};

/**
  #### joinRoom(name, spark)

  Join the room specified by `name`.
**/
ConnectionManager.prototype.joinRoom = function(name, spark) {
  var room;

  // if the spark already belongs to the room, then do nothing
  if (spark && spark._room === name) {
    return this.rooms[name];
  }

  // get the room
  room = this.rooms[name];

  // if we don't have a room, then create one
  if (! room) {
    room = this.rooms[name] = new Room(name);
  }

  // if the spark already has a room, then leave the room
  if (spark && spark._room && this.rooms[spark._room]) {
    this.rooms[spark._room].leave(spark);
  }

  // flag the spark as belonging to a particular room
  spark._room = name;

  // add the current spark to the room
  room.sparks.push(spark);

  // return the room
  return room;
};

/**
  #### library(req, res)

  Write the library to the response
**/
ConnectionManager.prototype.library = function() {
  var content = this.primus.library();

  return function(req, res) {
    res.writeHead(200, {
      'content-type': 'application/javascript'
    });

    res.end(content);
  };
};

/**
  #### _cleanupPeer(data)

  Cleanup a peer when we receive a leave notification.
**/
ConnectionManager.prototype._cleanupPeer = function(data) {
  var spark = data && data.id && this.sparks.get(data.id);

  // if we have the spark, look at removing it from the room
  if (spark && spark.scope && typeof spark.scope.leave === 'function') {
    spark.scope.leave(spark);
  }
};