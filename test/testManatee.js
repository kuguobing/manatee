/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * @overview A fully encapsulated instance of a Manatee used for testing.
 *
 *                   _.---.._
 *      _        _.-' \  \    ''-.
 *    .'  '-,_.-'   /  /  /       '''.
 *   (       _                     o  :
 *    '._ .-'  '-._         \  \-  ---]
 *                  '-.___.-')  )..-'
 *                           (_/
 */
var assert = require('assert-plus');
var bunyan = require('bunyan');
var ConfParser = require('../lib/confParser');
var fs = require('fs');
var exec = require('child_process').exec;
var path = require('path');
var manatee = require('../node_modules/node-manatee/bin/manatee_common');
var once = require('once');
var pg = require('pg');
var Client = pg.Client;
var spawn = require('child_process').spawn;
var shelljs = require('shelljs');
var url = require('url');
var util = require('util');
var uuid = require('node-uuid');
var vasync = require('vasync');
var verror = require('verror');

var ZK_URL = process.env.ZK_URL || 'localhost:2181';
var PARENT_ZFS_DS = process.env.PARENT_ZFS_DS;
var SITTER_CFG = './etc/sitter.json';
var BS_CFG = './etc/backupserver.json';
var SS_CFG = './etc/snapshotter.json';
var MY_IP = '127.0.0.1';
var ZK_CLIENT = null;

/**
 * Creates the three manatee processes and keeps track of them.
 */
function Manatee(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'options.log');
    assert.string(opts.zfsDataset, 'opts.zfsDataset');
    assert.number(opts.zfsPort, 'opts.zfsPort');
    assert.string(opts.mountPoint, 'opts.mountPoint');
    assert.number(opts.backupPort, 'opts.backupPort');
    assert.number(opts.postgresPort, 'opts.postgresPort');
    assert.string(opts.metadataDir, 'opts.metadataDir');
    assert.string(opts.shardPath, 'opts.shardPath');
    assert.optionalNumber(opts.postgresUserId, 'opts.postgresUserId');

    var log = opts.log;
    log.info('instance opts', opts);
    var self = this;

    this.postgresPort = opts.postgresPort;
    this.backupPort = opts.backupPort;
    this.postgresPort = opts.postgresPort;
    this.pgUrl = 'tcp://postgres@' + MY_IP + ':' + self.postgresPort +
                 '/postgres';
    this.configLocation = opts.metadataDir + '/config';
    this.postgresConf = self.configLocation + '/postgres.conf';
    this.cookieLocation = opts.metadataDir + '/sync_cookie';
    this.logLocation = opts.metadataDir + '/logs/';
    this.opts = opts;
    this.log = opts.log.child();
    this.sitterLogPath = self.logLocation + self.postgresPort + 'sitter.log';
    this.ssLogPath = self.logLocation + self.postgresPort + 'ss.log';
    this.bsLogPath = self.logLocation + self.backupPort + 'bs.log';
    this.shardPath = opts.shardPath;
    this.manatee = {};
    this.sitterLog = null;
    this.ssLog = null;
    this.bsLog = null;
    this.postgresUserId = opts.postgresUserId;

    log.info({
        sitterLog: self.sitterLogPath,
        ssLog: self.ssLogPath,
        bsLog: self.bsLogPath
    }, 'logs');

    console.error('logs:');
    console.error(self.sitterLogPath);
    console.error(self.ssLogPath);
    console.error(self.bsLogPath);

    vasync.pipeline({funcs: [
        function _createParentZfsDataset(_, _cb) {
            exec('zfs create ' + PARENT_ZFS_DS, function (err, stdout, stderr) {
                return _cb();
            });
        },
        function _createZfsChildDataset(_, _cb) {
            exec('zfs create ' + opts.zfsDataset, function (err, stdout, stderr)
            {
                self.log.info({
                    err: err,
                    ds: opts.zfsDataset
                }, 'created zfs dataset');
                return _cb();
            });
        },
        function _createMountDir(_, _cb) {
            shelljs.mkdir('-p', opts.mountPoint);
            return _cb();
        },
        function _setZfsMountPoint(_, _cb) {
            var cmd = 'zfs set mountpoint=' + opts.mountPoint + ' ' +
                opts.zfsDataset;
            exec(cmd, function (err) {
                return _cb(err);
            });
        },
        function _createPgDataDir(_, _cb) {
            shelljs.mkdir('-p', opts.mountPoint + '/data');
            return _cb();
        },
        function _createConfigDir(_, _cb) {
            shelljs.mkdir('-p', self.configLocation + '/data');
            return _cb();
        },
        function _chownMetadataDir(_, _cb) {
            exec('chown -R postgres ' + opts.metadataDir, _cb);
        },
        function _createLogDir(_, _cb) {
            shelljs.mkdir('-p', self.logLocation);
            return _cb();
        },
        function _updatePostgresConfig(_, _cb) {
            ConfParser.read('./etc/postgres.integ.conf', function (err, conf) {
                if (err) {
                    return _cb(new verror.VError(err));
                }

                ConfParser.set(conf, 'port', opts.postgresPort);

                ConfParser.write(self.postgresConf, conf, _cb);
            });
        },
        function _updateSitterConfig(_, _cb) {
            var cfg = JSON.parse(fs.readFileSync(SITTER_CFG));
            cfg.backupPort = opts.backupPort;
            cfg.postgresPort = opts.postgresPort;
            cfg.shardPath = self.shardPath;
            cfg.ip = MY_IP;

            cfg.postgresMgrCfg.dataDir = opts.mountPoint + '/data';
            cfg.postgresMgrCfg.snapShotterCfg.dataset = opts.zfsDataset;
            cfg.postgresMgrCfg.syncStateCheckerCfg.cookieLocation =
                self.cookieLocation;
            cfg.postgresMgrCfg.url = self.pgUrl;
            cfg.postgresMgrCfg.postgresConf = self.postgresConf;
            cfg.postgresMgrCfg.zfsClientCfg.dataset = opts.zfsDataset;
            cfg.postgresMgrCfg.zfsClientCfg.parentDataset =
                path.dirname(opts.zfsDataset);
            cfg.postgresMgrCfg.zfsClientCfg.zfsPort = opts.zfsPort;
            cfg.postgresMgrCfg.zfsClientCfg.mountpoint = opts.mountPoint;
            self.sitterCfg = cfg;
            return _cb();
        },
        function _updateBsConfig(_, _cb) {
            var cfg = JSON.parse(fs.readFileSync(BS_CFG));
            cfg.backupServerCfg.port = opts.backupPort;
            cfg.backupSenderCfg.dataset = opts.zfsDataset;
            self.bsCfg = cfg;
            return _cb();
        },
        function _updateSsConfig(_, _cb) {
            var cfg = JSON.parse(fs.readFileSync(SS_CFG));
            cfg.dataset = opts.zfsDataset;

            self.ssCfg = cfg;
            return _cb();
        },
        function _writeConfig(_, _cb) {
            shelljs.mkdir('-p', self.configLocation);
            self.sitterCfgLocation = self.configLocation + '/sitter.cfg';
            self.ssCfgLocation = self.configLocation + '/ss.cfg';
            self.bsCfgLocation = self.configLocation + '/bs.cfg';
            fs.writeFileSync(self.sitterCfgLocation,
                             JSON.stringify(self.sitterCfg));
            fs.writeFileSync(self.ssCfgLocation, JSON.stringify(self.ssCfg));
            fs.writeFileSync(self.bsCfgLocation, JSON.stringify(self.bsCfg));
            return _cb();
        },
        function _spawnComponents(_, _cb) {
            self.start(_cb);
        }
    ], arg: {}}, function (err, results) {
        self.log.info({
            err: err,
            results: err ? results : null
        }, 'finished starting manatee');
        return cb(err, self.manatee);
    });
}
module.exports = Manatee;

Manatee.prototype.kill = function kill(cb) {
    var self = this;
    var log = self.log;

    var barrier = vasync.barrier();
    barrier.start('sitter');
    barrier.start('snapshotter');
    barrier.start('backupServer');
    barrier.on('drain', function () {
        return cb();
    });

    if (self.manatee.sitter) {
        self.manatee.sitter.once('error', function (err) {
            log.error({
                err: err, url: self.pgUrl
            }, 'could not send SIGKILL');
        });

        self.manatee.sitter.removeAllListeners('close');
        self.manatee.sitter.once('close', function (pid, code) {
            log.info({
                url: self.pgUrl, code: code, procId: pid
            }, 'killed sitter');
            self.manatee.sitter = null;
            barrier.done('sitter');
        }.bind(self, self.manatee.sitter.pid));
    }

    if (self.manatee.snapshotter) {
        self.manatee.snapshotter.once('error', function (err) {
            log.error({
                err: err, url: self.pgUrl
            }, 'could not send SIGKILL');
        });

        self.manatee.snapshotter.removeAllListeners('close');
        self.manatee.snapshotter.once('close', function (pid, code) {
            log.info({
                url: self.pgUrl, code: code, procId: pid
            }, 'killed snapshotter');
            self.manatee.snapshotter = null;
            barrier.done('snapshotter');
        }.bind(self, self.manatee.snapshotter.pid));
    }

    if (self.manatee.backupServer) {
        self.manatee.backupServer.once('error', function (err) {
            log.error({
                err: err, url: self.pgUrl
            }, 'could not send SIGKILL');
        });

        self.manatee.backupServer.removeAllListeners('close');
        self.manatee.backupServer.once('close', function (pid, code) {
            log.info({
                url: self.pgUrl, code: code, procId: pid
            }, 'killed backupServer');
            self.manatee.backupServer = null;
            barrier.done('backupServer');
        }.bind(self, self.manatee.backupServer.pid));
    }

    if (self.manatee.sitter) {
        log.info({
            url: self.pgUrl, procId: self.manatee.sitter.pid
        }, 'killing sitter');
        self.manatee.sitter.kill('SIGKILL');
    } else {
        barrier.done('sitter');
    }

    if (self.manatee.snapshotter) {
        log.info({
            url: self.pgUrl, procId: self.manatee.snapshotter.pid
        }, 'killing snapshotter');
        self.manatee.snapshotter.kill('SIGKILL');
    } else {
        barrier.done('snapshotter');
    }

    if (self.manatee.backupServer) {
        log.info({
            url: self.pgUrl, procId: self.manatee.backupServer.pid
        }, 'killing backupServer');
        self.manatee.backupServer.kill('SIGKILL');
    } else {
        barrier.done('backupServer');
    }
};

Manatee.prototype.start = function start(cb) {
    var self = this;
    var log = self.log;
    var spawnSitterOpts = ['-l', 'child', '-o', 'noorphan', 'node',
        '--abort-on-uncaught-exception', '../sitter.js', '-vvv', '-f',
        self.sitterCfgLocation || './etc/sitter.json'];
    var spawnBsOpts = ['-l', 'child', '-o', 'noorphan', 'node',
        '--abort-on-uncaught-exception', '../backupserver.js', '-vvv', '-f',
        self.bsCfgLocation || './etc/backupserver.json'];
    var spawnSsOpts = ['-l', 'child', '-o', 'noorphan', 'node',
        '--abort-on-uncaught-exception', '../snapshotter.js', '-vvv', '-f',
        self.ssCfgLocation || './etc/snapshotter.json'];

    vasync.pipeline({funcs: [
        function _createLogFiles(_, _cb) {
            self.sitterLog = fs.createWriteStream(self.sitterLogPath);
            self.sitterLog.on('error', function (err) {
                log.error({err: err}, 'sitter logging stream got error');
            });
            self.ssLog = fs.createWriteStream(self.ssLogPath);
            self.ssLog.on('error', function (err) {
                log.error({err: err}, 'snapshotter logging stream got error');
            });
            self.bsLog = fs.createWriteStream(self.bsLogPath);
            self.bsLog.on('error', function (err) {
                log.error({err: err}, 'backupserver logging stream got error');
            });
            return _cb();
        },
        function _startSitter(_, _cb) {
            self.manatee.sitter = spawn('/usr/bin/ctrun', spawnSitterOpts);
            self.manatee.sitter.stdout.pipe(self.sitterLog);
            self.manatee.sitter.stderr.pipe(self.sitterLog);
            self.manatee.sitter.once('close', function (pid, code) {
                log.error({
                    url: self.pgUrl, code: code, procId: pid
                }, 'sitter died unexpectedly');
                self.manatee.sitter = null;
                throw new Error('sitter ' + self.sitterLogPath +
                                ' died unexpectedly');
            }.bind(self, self.manatee.sitter.pid));

            return _cb();
        },
        function _waitForPgToStart(_, _cb) {
            _cb = once(_cb);
            // check whether pg is up
            var intervalId = setInterval(function () {
                self.healthCheck(function (err) {
                    if (err) {
                        return;
                    }

                    clearInterval(intervalId);
                    return _cb();
                });
            }, 2000);

            // timeout if pg is still not up.
            setTimeout(function () {
                clearInterval(intervalId);
                return _cb(new verror.VError('postgres start timed out'));
            }, 30000).unref();

        },
        function _startSnapshotter(_, _cb) {
            self.manatee.snapshotter = spawn('/usr/bin/ctrun', spawnSsOpts);
            self.manatee.snapshotter.stdout.pipe(self.ssLog);
            self.manatee.snapshotter.stderr.pipe(self.ssLog);
            self.manatee.snapshotter.once('close', function (pid, code) {
                log.error({
                    url: self.pgUrl, code: code, procId: pid
                }, 'snapshotter died unexpectedly');
                throw new Error('snapshotter ' + self.ssLogPath +
                                ' died unexpectedly');
            }.bind(self, self.manatee.snapshotter.pid));
            return _cb();
        },
        function _startBackupServer(_, _cb) {
            self.manatee.backupServer = spawn('/usr/bin/ctrun', spawnBsOpts);
            self.manatee.backupServer.stdout.pipe(self.bsLog);
            self.manatee.backupServer.stderr.pipe(self.bsLog);

            self.manatee.backupServer.once('close', function (pid, code) {
                log.error({
                    url: self.pgUrl, code: code, procId: pid
                }, 'backupServer died unexpectedly');
                throw new Error('backupserver' + self.bsLogPath +
                                ' died unexpectedly');
            }.bind(self, self.manatee.backupServer.pid));
            return _cb();
        }
    ], arg: {}}, function (err, results) {
        log.info({err: err, results: err ? results: null},
                 'Manatee.start: exiting');

        return cb(err);
    });
};

/**
 * @return {string} return the pgurl that a client would return. e.g.:
 * tcp://10.0.0.0:5432
 */
Manatee.prototype.getPgUrl = function getPgUrl() {
    var self = this;
    return 'tcp://' + MY_IP + ':' + self.postgresPort;
};

Manatee.prototype.healthCheck = function (callback) {
    var self = this;
    var log = self.log;
    log.info('Manatee.health: entering');
    callback = once(callback);
    var client = new Client(self.pgUrl);

    try {
        client.connect(function (err) {
            if (err) {
                client.end();
                return callback(err);
            }
            client.query('select current_time;', function (err2) {
                if (err2) {
                    log.trace({err: err2}, 'Manatee.health: failed');
                }
                client.end();
                return callback(err2);
            });
        });
    } catch (e) {
        return callback(e);
    }
};

function getPostgresUrl(ip, port, db) {
    return 'tcp://postgres@' + ip + ':' + port + '/' + db;
}
