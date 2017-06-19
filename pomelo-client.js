// node版本, 使用websocket连接

var events = require('events');
var util = require('util');
var Protocol = require('pomelo-protocol');
var protobuf = require('pomelo-protobuf');
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

  // 心跳
  this.heartbeatInterval = 0;
  this.heartbeatTimeout = 0;
  this.heartbeatId = null;
  this.heartbeatTimeoutId = null;

  var me = this;

  // 数据包处理
  this.handles = {};

  // 握手消息
  this.handles[Package.TYPE_HANDSHAKE] = function (data) {
    data = JSON.parse(Protocol.strdecode(data));
    if (data.code == CODE_OLD_CLIENT) {
      me.emit('error', '客户端版本太旧');
      return;
    }

    if (data.code !== CODE_OK) {
      me.emit('error', '握手失败');
    }

    // 心跳协议
    var heartbeat = data.sys.heartbeat;
    if (heartbeat) {
      me.heartbeatInterval = heartbeat * 1000;
      me.heartbeatTimeout = me.heartbeatInterval * 2;
    }

    // 字典
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
      me.useProtos = true;
      me.protos.version = protos.protoVersion || 0;
      me.protos.server = protos.server;
      me.protos.client = protos.client;
      protobuf.init({
        encoderProtos: me.protos.client,
        decoderProtos: me.protos.server
      });
    }

    if (typeof this.handshakeCallback === 'function') {
      this.handshakeCallback(data)
    }

    // 响应握手
    me.send(Package.encode(Package.TYPE_HANDSHAKE_ACK));

    if (me.initCallback) {
      me.initCallback(me.socket);
      me.initCallback = null;
    }
  };

  // 心跳消息
  this.handles[Package.TYPE_HEARTBEAT] = function () {
    // 清除超时
    if (me.heartbeatTimeoutId) {
      clearTimeout(me.heartbeatTimeoutId);
      me.heartbeatTimeoutId = null;
    }

    if (me.heartbeatId) {
      return;
    }

    // 发送心跳包
    me.heartbeatId = setTimeout(function () {
      me.heartbeatId = null;
      me.send(Package.encode(Package.TYPE_HEARTBEAT));
      // 超时
      me.heartbeatTimeoutId = setTimeout(function () {
        me.emit('heartbeatTimeout');
        me.disconnect();
      }, me.heartbeatTimeout + 500/*延迟*/);
    }, me.heartbeatInterval);
  };

  // 业务消息,服务器推送/客户端请求回调
  this.handles[Package.TYPE_DATA] = function (data) {
    var msg = Message.decode(data);

    // 字典处理
    if (msg.compressRoute) {
      var dictCode2Route = me.dictCode2Route[msg.route];
      if (!dictCode2Route) {
        console.log('找不到路由字典[' + msg.route + ']');
        return;
      }
      msg.route = dictCode2Route;
    }

    // 推送消息
    var requestId = msg.id;
    if (requestId) {
      msg.route = me.requestRoutes[requestId];
      delete me.requestRoutes[requestId];
    }

    // protobuf
    var body;
    if (me.useProtos && me.protos.server[msg.route]) {
      body = protobuf.decode(msg.route, msg.body);
    } else {
      body = JSON.parse(Protocol.strdecode(msg.body))
    }

    if (!requestId) {
      me.emit(msg.route, body);
      return;
    }

    // 请求消息
    var requestRouteCallback = me.requestRouteCallbacks[requestId];
    if (!requestRouteCallback) {
      return;
    }
    delete me.requestRouteCallbacks[requestId];
    requestRouteCallback.call(null, body);
  };

  // 被T消息
  this.handles[Package.TYPE_KICK] = function (data) {
    me.emit('onKick', JSON.parse(Protocol.strdecode(data)));
  };
};

util.inherits(PomeloClient, events.EventEmitter);

PomeloClient.prototype.init = function (params, done) {
  if (this.socket) {
    this.disconnect();
  }

  // 请求
  this.useCrypto = false;
  this.requestId = 0;
  this.requestRoutes = {};
  this.requestRouteCallbacks = {};

  // 字典
  this.useDict = false;
  this.dictCode2Route = {};
  this.dictRoute2Code = {};

  // protobuf
  this.useProtos = false;
  this.protos = {};

  // 握手信息
  this.handshakeBuffer = {
    'sys': {
      protoVersion: 0
    },
    'user': {}
  };

  if (params.encrypt) {
    this.useCrypto = true;
    console.log('加密未实现');
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
    me.emit('io-error', event)
  };
  socket.onclose = function (event) {
    me.emit('close', event);
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
    console.log('加密未实现');
  }

  // 字典
  var compressRoute = false;
  if (this.useDict && this.dictRoute2Code[route]) {
    route = this.dictRoute2Code[route];
    compressRoute = true;
  }

  // protobuf
  if (this.useProtos && this.protos.client[route]) {
    msg = protobuf.encode(route, msg);
  } else {
    msg = Protocol.strencode(JSON.stringify(msg));
  }

  var type = requestId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;
  msg = Message.encode(requestId, type, compressRoute, route, msg);
  this.send(Package.encode(Package.TYPE_DATA, msg));
};

PomeloClient.prototype.disconnect = function () {
  var socket = this.socket;
  if (socket) {
    socket.close();
    this.socket = null
  }

  if (this.heartbeatId) {
    clearTimeout(this.heartbeatId);
    this.heartbeatId = null;
  }
  if (this.heartbeatTimeoutId) {
    clearTimeout(this.heartbeatTimeoutId);
    this.heartbeatTimeoutId = null;
  }
};

function test() {
  var pomeloClient = new PomeloClient();
  pomeloClient.on('close', function () {
    console.log('关闭');
  });
  pomeloClient.init({
    host: '127.0.0.1',
    port: 1088
  }, function () {
    pomeloClient.request('gate.gateHandler.entry', function (data) {
      pomeloClient.init({
        host: data.ip,
        port: data.port
      }, function () {
        console.log('成功连通连接器');
      });
    });
  });
}
// test();

module.exports = PomeloClient;