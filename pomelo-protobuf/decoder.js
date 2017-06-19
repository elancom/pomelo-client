var codec = require('./codec');
var util = require('./util');

var Decoder = function () {
  this.id = new Date().getTime();
};

Decoder.prototype.init = function (protos) {
  this.buffer = null;
  this.offset = 0;
  this.protos = protos || {};
};

Decoder.prototype.setProtos = function (protos) {
  if (!!protos) {
    this.protos = protos;
  }
};

Decoder.prototype.decode = function (route, buf) {
  var protos = this.protos[route];

  this.buffer = buf;
  this.offset = 0;

  if (!!protos) {
    return this.decodeMsg({}, protos, this.buffer.length);
  }

  return null;
};

Decoder.prototype.decodeMsg = function (msg, protos, length) {
  while (this.offset < length) {
    var head = this.getHead();
    var type = head.type;
    var tag = head.tag;
    var name = protos.__tags[tag];

    switch (protos[name].option) {
      case 'optional' :
      case 'required' :
        msg[name] = this.decodeProp(protos[name].type, protos);
        break;
      case 'repeated' :
        if (!msg[name]) {
          msg[name] = [];
        }
        this.decodeArray(msg[name], protos[name].type, protos);
        break;
    }
  }

  return msg;
};

/**
 * Test if the given msg is finished
 */
Decoder.prototype.isFinish = function (msg, protos) {
  return (!protos.__tags[this.peekHead().tag]);
};

/**
 * Get property head from protobuf
 */
Decoder.prototype.getHead = function (buffer) {
  var tag = codec.decodeUInt32(this.getBytes(false, buffer));

  return {
    type: tag & 0x7,
    tag: tag >> 3
  };
};

/**
 * Get tag head without move the offset
 */
Decoder.prototype.peekHead = function (buffer) {
  var tag = codec.decodeUInt32(this.peekBytes(buffer));

  return {
    type: tag & 0x7,
    tag: tag >> 3
  };
};

Decoder.prototype.decodeProp = function (type, protos) {
  switch (type) {
    case 'uInt32':
      return codec.decodeUInt32(this.getBytes(false));
    case 'int32' :
    case 'sInt32' :
      return codec.decodeSInt32(this.getBytes(false));
    case 'float' :
      var float = buffer.readFloatLE(this.offset);
      this.offset += 4;
      return float;
    case 'double' :
      var double = this.buffer.readDoubleLE(this.offset);
      this.offset += 8;
      return double;
    case 'string' :
      var length = codec.decodeUInt32(this.getBytes(false));

      var str = this.buffer.toString('utf8', this.offset, this.offset + length);
      this.offset += length;

      return str;
    default :
      var message = protos && (protos.__messages[type] || protos['message ' + type]);
      if (message) {
        var length = codec.decodeUInt32(this.getBytes(false));
        var msg = {};
        this.decodeMsg(msg, message, this.offset + length);
        return msg;
      }
      break;
  }
};

Decoder.prototype.decodeArray = function (array, type, protos) {
  if (util.isSimpleType(type)) {
    var length = codec.decodeUInt32(this.getBytes(false));

    for (var i = 0; i < length; i++) {
      array.push(this.decodeProp(type, protos));
    }
  } else {
    array.push(this.decodeProp(type, protos));
  }
};

Decoder.prototype.getBytes = function (flag) {
  var bytes = [];
  var pos = this.offset;
  flag = flag || false;

  var b;
  do {
    b = this.buffer.readUInt8(pos);
    bytes.push(b);
    pos++;
  } while (b >= 128);

  if (!flag) {
    this.offset = pos;
  }
  return bytes;
};

Decoder.prototype.peekBytes = function () {
  return this.getBytes(true);
};

module.exports = Decoder;