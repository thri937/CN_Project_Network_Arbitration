const fs = require('node:fs');
if (fs.realpathSync && fs.realpathSync.native) {
  fs.realpathSync.native = fs.realpathSync;
}
if (fs.realpath && fs.realpath.native) {
  fs.realpath.native = fs.realpath;
}
