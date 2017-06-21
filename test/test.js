var PomeloClient = require('../pomelo-client');

function test() {
  var params = {
    host: '127.0.0.1',
    port: 1088
  };

  var pomeloClient = new PomeloClient();
  pomeloClient.on('disconnect', function (event) {
    if (event.code == 1000) {
      console.log('normal close by owner');
    }
    else {
      console.log('network disconnect');
      setTimeout(function () {
        pomeloClient.init(params, connect);
      }, 1000);
    }
  });
  pomeloClient.on('close', function () {
    console.log('closed');
  });
  var connect = function () {
    pomeloClient.request('gate.gateHandler.entry', function (data) {
      console.log('entry gate data: ', data);
      if (data.code != 200) {
        console.log('fail and reconnect');
        setTimeout(function () {
          pomeloClient.init(params, connect);
        }, 1000);
        return;
      }
      console.log('connector info:', data);
      pomeloClient.init({
        host: data.ip,
        port: data.port
      }, function () {
        console.log('connect connector ok');
      });
    });
  };
  pomeloClient.init(params, connect);
}
test();