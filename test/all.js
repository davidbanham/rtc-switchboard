var server = require('./helpers/server');

server.start(function(test, board) {
  require('./connect')(test, board);
  require('./broadcast-by-default')(test, board);
  require('./room-isolation')(test, board);
  require('./room-leave')(test, board);
  require('./room-info')(test, board);
  require('./to-messaging')(test, board);
});
