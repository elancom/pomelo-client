var Encoder = require('./encoder');
var Decoder = require('./decoder');
var parser = require('./parser');

var Protobuf = function () {

};

/**
 * [encode the given message, return a Buffer represent the message encoded by protobuf]
 * @param  {[type]} key The key to identify the message type.
 * @param  {[type]} msg The message body, a js object.
 * @return {[type]} The binary encode result in a Buffer.
 */
Protobuf.prototype.encode = function (key, msg) {
  return this.encoder.encode(key, msg);
};

Protobuf.prototype.encode2Bytes = function (key, msg) {
  var buffer = this.encode(key, msg);
  if (!buffer || !buffer.length) {
    console.warn('encode msg failed! key : %j, msg : %j', key, msg);
    return null;
  }
  var bytes = new Uint8Array(buffer.length);
  for (var offset = 0; offset < buffer.length; offset++) {
    bytes[offset] = buffer.readUInt8(offset);
  }

  return bytes;
};

Protobuf.prototype.encodeStr = function (key, msg, code) {
  code = code || 'base64';
  var buffer = this.encode(key, msg);
  return !!buffer ? buffer.toString(code) : buffer;
};

Protobuf.prototype.decode = function (key, msg) {
  return this.decoder.decode(key, msg);
};

Protobuf.decodeStr = function (key, str, code) {
  code = code || 'base64';
  var buffer = new Buffer(str, code);

  return !!buffer ? this.decode(key, buffer) : buffer;
};

Protobuf.prototype.parse = function (json) {
  return parser.parse(json);
};

Protobuf.prototype.setEncoderProtos = function (protos) {
  this.encoder.init(protos);
};

Protobuf.prototype.setDecoderProtos = function (protos) {
  this.decoder.init(protos);
};

Protobuf.prototype.init = function (opts) {
  this.encoder = new Encoder();

  //On the serverside, use serverProtos to encode messages send to client
  this.encoder.init(opts.encoderProtos);

  this.decoder = new Decoder();
  //On the serverside, user clientProtos to decode messages receive from clients
  this.decoder.init(opts.decoderProtos);
};

module.exports = Protobuf;