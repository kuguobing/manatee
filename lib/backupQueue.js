/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * @overview FIFO queue used to hold backup requests.
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
var EventEmitter = require('events').EventEmitter;
var util = require('util');

/**
 * FIFO queue used to hold backup requests.
 * @constructor
 * @augments EventEmitter
 *
 * @fires BackupQueue#push When an object is pushed into the queue.
 *
 * @param {object} options Options object.
 * @param {Bunyan} options.log Bunyan logger.
 *
 * @throws {Error} If the options object is malformed.
 */
function BackupQueue(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    EventEmitter.call(this);

    /** @type {Bunyan} The bunyan log object */
    this._log = options.log.child({component: 'BackupQueue'}, true);
    /** @type {array} The array that backs this queue */
    this._queue = [];
}

module.exports = BackupQueue;
util.inherits(BackupQueue, EventEmitter);

/**
 * Push an object into the queue.
 * @param {object} object Object to push into the queue.
 */
BackupQueue.prototype.push = function push(object) {
    var self = this;
    self._log.info('pushed object %j into queue', object);
    self._queue.push(object);
    /**
     * Push event, emitted when an object has been pushed into the queue.
     *
     * @event BackupQueue#push
     * @type {object}
     */
    self.emit('push', object);
};

/**
 * @callback BackupQueue-popCb
 * @param {object} object The popped object.
 */

/**
 * Pop an object from the queue.
 * @param {BackupQueue-popCb} callback
 */
BackupQueue.prototype.pop = function pop(callback) {
    var self = this;
    var object = self._queue.pop();
    self._log.info('popped object %j from queue', object);
    return callback(object);
};

/**
 * @callback BackupQueue-getCb
 * @param {object} object
 */

/**
 * Get an object that corresponds to the uuid.
 *
 * @param {string} uuid UUID of the job.
 * @param {BackupQueue-getCb} callback
 */
BackupQueue.prototype.get = function get(uuid, callback) {
    var self = this;
    var log = self._log;
    log.info('getting backupjob with uuid: ' + uuid);
    var job;
    for (var i = 0; i < self._queue.length; i++) {
        var backupJob = self._queue[i];
        if (backupJob.uuid === uuid) {
            log.info('found backup job', backupJob);
            job = backupJob;
            break;
        }
    }
    return callback(job);
};
