var events = require('events');
var util = require('util');
var Protocol = require('pomelo-protocol');
var Protobuf = require('./pomelo-protobuf/protobuf');
var WebSocket = require('ws');

var Package = Protocol.Package;
var Message = Protocol.Message;

var CODE_OK = 200;
var CODE_OLD_CLIENT = 501;

var NOOP = function () {
};

var PomeloClient = function () {
  events.EventEmitter.call(this);

  this.socket = null;

  // heartbeat
  this.heartbeatInterval = 0;
  this.heartbeatTimeout = 0;
  this.heartbeatId = null;
  this.heartbeatTimeoutId = null;

  var me = this;

  this.handles = {};
  // handshake
  this.handles[Package.TYPE_HANDSHAKE] = function (data) {
    data = JSON.parse(Protocol.strdecode(data));
    if (data.code == CODE_OLD_CLIENT) {
      me.emit('error', 'the client version is too old');
      return;
    }

    if (data.code !== CODE_OK) {
      me.emit('error', 'handshake failed');
    }

    // heartbeat
    var heartbeat = data.sys.heartbeat;
    if (heartbeat) {
      me.heartbeatInterval = heartbeat * 1000;
      me.heartbeatTimeout = me.heartbeatInterval * 2;
    }

    // dict
    var dict = data.sys.dict;
    if (dict) {
      me.useDict = true;
      for (var route in dict) {
        var code = dict[route];
        me.dictCode2Route[code] = route;
        me.dictRoute2Code[route] = code;
      }
    }

    // protobuf
    var protos = data.sys.protos;
    if (protos) {
      me.protobuf = new Protobuf();
      me.useProtos = true;
      me.protos.version = protos.protoVersion || 0;
      me.protos.server = protos.server;
      me.protos.client = protos.client;
      me.protobuf.init({
        encoderProtos: me.protos.client,
        decoderProtos: me.protos.server
      });
    }

    if (typeof this.handshakeCallback === 'function') {
      this.handshakeCallback(data)
    }

    // ack
    me.send(Package.encode(Package.TYPE_HANDSHAKE_ACK));

    if (me.initCallback) {
      me.initCallback(me.socket);
      me.initCallback = null;
    }
  };

  // heartbeat
  this.handles[Package.TYPE_HEARTBEAT] = function () {
    // clear heartbeat timeout fn
    if (me.heartbeatTimeoutId) {
      clearTimeout(me.heartbeatTimeoutId);
      me.heartbeatTimeoutId = null;
    }

    if (me.heartbeatId) {
      return;
    }

    // send heartbeat packet 
    me.heartbeatId = setTimeout(function () {
      me.heartbeatId = null;
      me.send(Package.encode(Package.TYPE_HEARTBEAT));
      // emit heartbeat timeout fn
      me.heartbeatTimeoutId = setTimeout(function () {
        me.emit('heartbeatTimeout');
        me.disconnect();
      }, me.heartbeatTimeout + 500/*delay*/);
    }, me.heartbeatInterval);
  };

  // data message, server push/client request
  this.handles[Package.TYPE_DATA] = function (data) {
    var msg = Message.decode(data);

    // dict
    if (msg.compressRoute) {
      var dictCode2Route = me.dictCode2Route[msg.route];
      if (!dictCode2Route) {
        util.log('not found dict[' + msg.route + ']');
        return;
      }
      msg.route = dictCode2Route;
    }

    // if client request, we need find route by requestId on client
    var requestId = msg.id;
    if (requestId) {
      msg.route = me.requestRoutes[requestId];
      delete me.requestRoutes[requestId];
    }

    // protobuf
    var body;
    if (me.useProtos && me.protos.server[msg.route]) {
      body = me.protobuf.decode(msg.route, msg.body);
    } else {
      body = JSON.parse(Protocol.strdecode(msg.body))
    }

    if (!requestId) {
      me.emit(msg.route, body);
      return;
    }

    // request message
    var requestRouteCallback = me.requestRouteCallbacks[requestId];
    if (!requestRouteCallback) {
      return;
    }
    delete me.requestRouteCallbacks[requestId];
    requestRouteCallback.call(null, body);
  };

  // kick
  this.handles[Package.TYPE_KICK] = function (data) {
    me.emit('onKick', JSON.parse(Protocol.strdecode(data)));
  };
};

util.inherits(PomeloClient, events.EventEmitter);

PomeloClient.prototype.init = function (params, done) {
  if (this.socket) {
    this.disconnect();
  }

  // request
  this.useCrypto = false;
  this.requestId = 0;
  this.requestRoutes = {};
  this.requestRouteCallbacks = {};

  // dict
  this.useDict = false;
  this.dictCode2Route = {};
  this.dictRoute2Code = {};

  // protobuf
  this.useProtos = false;
  this.protos = {};

  // handshake data
  this.handshakeBuffer = {
    'sys': {
      protoVersion: 0
    },
    'user': {}
  };

  if (params.encrypt) {
    this.useCrypto = true;
    util.log('NO-IMPL');
  }
  this.initCallback = done;

  var me = this;

  var endpoint = 'ws://' + params.host + ':' + params.port;
  var socket = new WebSocket(endpoint);
  socket.binaryType = 'arraybuffer';
  socket.onopen = function (event) {
    var packet = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(me.handshakeBuffer)));
    this.send(packet)
  };
  socket.onmessage = function (event) {
    var msg = Package.decode(event.data);
    if (Array.isArray(msg)) {
      for (var i = 0; i < msg.length; i++) {
        me.handles[msg[i].type](msg[i].body);
      }
    }
    else {
      me.handles[msg.type](msg.body);
    }
  };
  socket.onerror = function (event) {
    me.emit('io-error', event);
    util.log('onerror: ', event.message);
  };
  socket.onclose = function (event) {
    me.onDisconnect(event);
    me.emit('disconnect', event);
  };
  this.socket = socket;
};

PomeloClient.prototype.send = function (packet) {
  try {
    this.socket.send(packet)
  } catch (e) {
    this.emit('io-error', e)
  }
};

PomeloClient.prototype.request = function (route, msg, done) {
  if (!route) {
    return;
  }

  if (arguments.length == 1) {
    msg = {};
    done = NOOP
  }
  else if (arguments.length == 2) {
    done = msg;
    msg = {};
  }

  var requestId = ++this.requestId;
  this.sendMessage(requestId, route, msg);
  this.requestRoutes[requestId] = route;
  this.requestRouteCallbacks[requestId] = done;
};

PomeloClient.prototype.sendMessage = function (requestId, route, msg) {
  if (this.useCrypto) {
    util.log('NO-IMPL');
  }

  // dict
  var compressRoute = false;
  if (this.useDict && this.dictRoute2Code[route]) {
    route = this.dictRoute2Code[route];
    compressRoute = true;
  }

  // protobuf
  if (this.useProtos && this.protos.client[route]) {
    msg = me.protobuf.encode(route, msg);
  } else {
    msg = Protocol.strencode(JSON.stringify(msg));
  }

  var type = requestId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;
  msg = Message.encode(requestId, type, compressRoute, route, msg);
  this.send(Package.encode(Package.TYPE_DATA, msg));
};

PomeloClient.prototype.disconnect = function () {
  if (!this.socket) {
    return;
  }
  this.socket.closeByOwner = true;
  //   1000: 'normal',
  //   1001: 'going away',
  //   1002: 'protocol error',
  //   1003: 'unsupported data',
  //   1004: 'reserved',
  //   1005: 'reserved for extensions',
  //   1006: 'reserved for extensions',
  //   1007: 'inconsistent or invalid data',
  //   1008: 'policy violation',
  //   1009: 'message too big',
  //   1010: 'extension handshake missing',
  //   1011: 'an unexpected condition prevented the request from being fulfilled',
  //   1012: 'service restart',
  //   1013: 'try again later'
  this.socket.close(1000);
  this.socket = null;
};

PomeloClient.prototype.onDisconnect = function (event) {
  if (this.heartbeatId) {
    clearTimeout(this.heartbeatId);
    this.heartbeatId = null;
  }
  if (this.heartbeatTimeoutId) {
    clearTimeout(this.heartbeatTimeoutId);
    this.heartbeatTimeoutId = null;
  }
};

PomeloClient.prototype.close = function () {
  if (this.closed) {
    return;
  }
  this.closed = true;
  this.emit('close', this);
};

module.exports = PomeloClient;