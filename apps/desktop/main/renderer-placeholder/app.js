// Placeholder renderer: no Node, no framework. Reads the snapshot pushed by the
// main process through window.wechatAgent and shows the connection state.
(function () {
  var STATE = { disconnected: '离线', connecting: '连接中', incompatible: '协议不兼容', unpaired: '未配对', ready: '就绪' };
  var GATE = { open: '开（可写）', closed: '关', stopping: '停止中', quiescence_unconfirmed: '静止未确认' };
  var STEP = { discover: '发现平台', contract: '契约校验', pairing: '配对', window: '窗口绑定', account: '账号确认', baseline: '基线' };
  var text = function (id, value) { document.getElementById(id).textContent = value; };
  var api = window.wechatAgent;
  var keys = api ? Object.keys(api).sort().join(',') : '(无)';
  text('bridge', 'window.wechatAgent 暴露：' + keys);
  if (!api) return;
  api.subscribe(function (s) {
    text('conn-state', STATE[s.connection.state] || s.connection.state);
    text('conn-endpoint', s.connection.endpoint);
    text('conn-api', (s.connection.product || '—') + ' / ' + (s.connection.apiVersion || '—'));
    text('gate', GATE[s.inputGate] || s.inputGate);
    text('revision', String(s.revision));
    var list = document.getElementById('steps');
    list.textContent = '';
    s.connection.steps.forEach(function (step) {
      var li = document.createElement('li');
      li.dataset.state = step.state;
      li.textContent = (STEP[step.key] || step.key) + (step.detail ? '：' + step.detail : '');
      list.appendChild(li);
    });
  });
  api.call('connection.check', {}).then(function (r) {
    text('bridge-call', 'connection.check → ' + r.state);
  }, function (e) {
    text('bridge-call', 'connection.check 失败：' + e.message);
  });
  // A non-whitelisted method must be refused by the preload before it reaches main.
  api.call('fs.read', {}).then(function () {
    text('bridge-deny', '白名单失效：fs.read 被放行！');
  }, function (e) {
    text('bridge-deny', '非白名单方法已拒绝（' + e.message + '）');
  });
})();
