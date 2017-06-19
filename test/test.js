var PomeloClient = require('../pomelo-client');

function test() {
  var params = {
    host: '127.0.0.1',
    port: 1088
  };

  var pomeloClient = new PomeloClient();
  pomeloClient.on('disconnect', function (event) {
    if (event.code == 1000) {
      console.log('正常断开');
    }
    else {
      console.log('网络异常');
      setTimeout(function () {
        pomeloClient.init(params, connect);
      }, 1000);
    }
  });
  pomeloClient.on('close', function () {
    console.log('关闭');
  });
  var connect = function () {
    pomeloClient.request('gate.gateHandler.entry', function (data) {
      console.log('进入网关返回:', data);
      if (data.code != 200) {
        console.log('连接器失败, 重连');
        setTimeout(function () {
          pomeloClient.init(params, connect);
        }, 1000);
        return;
      }
      console.log('连接器:', data);
      pomeloClient.init({
        host: data.ip,
        port: data.port
      }, function () {
        console.log('成功连通连接器');
      });
    });
  };
  pomeloClient.init(params, connect);
}
test();