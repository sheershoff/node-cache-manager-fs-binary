'use strict';

/**
 * Module dependencies
 */
var noop = function () {
};
var fs = require("fs");
var fsp = require("fs-promise");
var crypto = require('crypto');
var path = require('path');
var async = require('async');
var extend = require('extend');
var uuid = require('uuid');
var zlib = require('zlib');
var glob = require('glob');
var streamifier = require('streamifier');
const gzip = zlib.createGzip();

/**
 * Export 'DiskStore'
 */

module.exports = {
    create: function (args) {
        return new DiskStore(args && args.options ? args.options : args);
    }
};

/**
 * Helper function that revives buffers from object representation on JSON.parse
 */
function bufferReviver(k, v) {
    if (
        v !== null &&
        typeof v === 'object' &&
        'type' in v &&
        v.type === 'Buffer' &&
        'data' in v &&
        Array.isArray(v.data)) {
        return new Buffer(v.data);
    }
    return v;
}

/**
 * helper object with meta-informations about the cached data
 */
function MetaData() {

    // the key for the storing
    this.key = null;
    // data to store
    this.value = null;
    // temporary filename for the cached file because filenames cannot represend urls completely
    this.filename = null;
    // expirydate of the entry
    this.expires = null;
    // size of the current entry
    this.size = null;
}

/**
 * construction of the disk storage
 */
function DiskStore(options) {
    options = options || {};

    this.options = extend({
        path: 'cache/',
        ttl: 60,
        maxsize: 0,
        zip: false
    }, options);


    // check storage directory for existence (or create it)
    if (!fs.existsSync(this.options.path)) {
        fs.mkdirSync(this.options.path);
    }

    this.name = 'diskstore';

    // current size of the cache
    this.currentsize = 0;

    // internal array for informations about the cached files - resists in memory
    this.collection = {};

    // fill the cache on startup with already existing files
    if (!options.preventfill) {

        this.intializefill(options.fillcallback);
    }
}


/**
 * indicate, whether a key is cacheable
 */
DiskStore.prototype.isCacheableValue = function (value) {

    return value !== null && value !== undefined;
};

/**
 * delete an entry from the cache
 */
DiskStore.prototype.del = function (key, options, cb) {

    if (typeof options === 'function') {
        cb = options;
        options = null;
    }
    cb = typeof cb === 'function' ? cb : noop;

    // get the metainformations for the key
    var metaData = this.collection[key];
    if (!metaData) {
        return cb(null);
    }

    // check if the filename is set
    if (!metaData.filename) {
        return cb(null);
    }
    // check for existance of the file
    fsp.readFile(metaData.filename, { encoding : 'ascii' }).
        then(function(metaExtraContent) {
            // delete the files
            if (! metaExtraContent) {
                reject();
                return;
            }

            try {
                var metaExtra = JSON.parse(metaExtraContent);
            }
            catch(e) {
                reject();
                return;
            }

            if (metaExtra.value && metaExtra.value.binary && typeof metaExtra.value.binary === 'object' && metaExtra.value.binary != null) {
                // unlink binaries
                async.forEachOf(metaExtra.value.binary, function (v, k, cb) {
                    fs.unlink(metaExtra.value.binary[k], cb);
                }, function (err) {
                });
                return fsp.unlink(metaData.filename);
            } else {
                return fsp.unlink(metaData.filename);
            }
        }, function () {
            // not found
            cb(null);
        }).then(function () {
            // update internal properties
            this.currentsize -= metaData.size;
            this.collection[key] = null;
            delete this.collection[key];
            cb(null);
        }.bind(this)).catch(function (err) {
            cb(null);
        });
};


/**
 * zip an input string if options want that
 */
DiskStore.prototype.zipIfNeeded = function (data, cb) {
    if (this.options.zip) {
        zlib.deflate(data, function (err, buffer) {
            if (!err) {
                cb(null, buffer);
            }
            else {
                cb(err, null);
            }
        });
    }
    else {
        cb(null, data);
    }
}

/**
 * zip an input string if options want that
 */
DiskStore.prototype.unzipIfNeeded = function (data, cb) {
    if (this.options.zip) {
        zlib.unzip(data, function (err, buffer) {
            if (!err) {
                cb(null, buffer);
            }
            else {
                cb(err, null);
            }
        });
    }
    else {
        cb(null, data);
    }
}

/**
 * set a key into the cache
 */
DiskStore.prototype.set = function (key, val, options, cb) {

    cb = typeof cb === 'function' ? cb : noop;

    if (typeof options === 'function') {
        cb = options;
        options = null;
    }

    // get ttl
    var ttl = (options && (options.ttl || options.ttl === 0)) ? options.ttl : this.options.ttl;

    // move binary data to binary from value
    var binary;
    if (typeof val.binary === 'object' && val.binary != null) {
        binary = val.binary;
        delete val['binary'];
        val.binary = {};
    }

    var metaData = extend({}, new MetaData(), {
        key: key,
        value: val,
        expires: Date.now() + ((ttl || 60) * 1000),
        filename: this.options.path + '/cache_' + uuid.v4() + '.dat'
    });

    var binarySize = 0;

    if (binary) {
        for (var binkey in binary) {
            if (!binary.hasOwnProperty(binkey)) continue;
            // put storage filenames into stored value.binary object
            metaData.value.binary[binkey] = metaData.filename.replace(/\.dat$/, '_' + binkey + '.bin');
            // calculate the size of the binary data
            binarySize += binary[binkey].length || 0;
        }
    }

    metaData.size = JSON.stringify(metaData).length + binarySize;

    var stream = JSON.stringify(metaData);

    if (this.options.maxsize && metaData.size > this.options.maxsize) {
        return cb(new Error('Item size too big.'));
    }


    // remove the key from the cache (if it already existed, this updates also the current size of the store)
    this.del(key, function (err) {

        if (err) {
            return cb(err);
        }

        // check used space and remove entries if we use too much space
        this.freeupspace(function () {

            try {

                var self = this;
                // write binary data and cache file
                async.series(
                    [
                        function (cb) {
                            // write binary
                            if (binary) {
                                async.forEachOf(binary, function (v, k, cb) {
                                    fs.writeFile(metaData.value.binary[k], v, cb);
                                }, function (err) {
                                    cb(err);
                                });
                            } else {
                                cb();
                            }
                        },
                        function (cb) {
                            self.zipIfNeeded(stream, function (err, processedStream) {

                                // write data into the cache-file
                                fs.writeFile(metaData.filename, processedStream, function (err) {

                                    if (err) {
                                        return cb(err);
                                    }

                                    // remove data value from memory
                                    metaData.value = null;
                                    delete metaData.value;

                                    self.currentsize += metaData.size;

                                    // place element with metainfos in internal collection
                                    self.collection[metaData.key] = metaData;

                                    // restore val binary key
                                    if (binary) {
                                        if(this.options.binaryAsStream) {
                                            for(key in binary){
                                                if(binary.hasOwnProperty(key)){
                                                    val.binary[key] = streamifier.createReadStream(binary[key], {encoding: null});
                                                }
                                            }
                                        }else{
                                            val.binary = binary;
                                        }
                                    }

                                    return cb(null, val);

                                }.bind(self));
                            }.bind(self))
                        }
                    ],
                    function (err, result) {
                        cb(err, result);
                    }
                );

            } catch (err) {

                return cb(err);
            }

        }.bind(this));

    }.bind(this));

};

/**
 * helper method to free up space in the cache (regarding the given spacelimit)
 */
DiskStore.prototype.freeupspace = function (cb) {

    cb = typeof cb === 'function' ? cb : noop;

    if (!this.options.maxsize) {
        return cb(null);
    }

    // do we use to much space? then cleanup first the expired elements
    if (this.currentsize > this.options.maxsize) {
        this.cleanExpired();
    }

    // when the spaceusage is to high, remove the oldest entries until we gain enough diskspace
    if (this.currentsize <= this.options.maxsize) {
        return cb(null);
    }

    // for this we need a sorted list basend on the expire date of the entries (descending)
    var tuples = [], key;
    for (key in this.collection) {
        tuples.push([key, this.collection[key].expires]);
    }

    tuples.sort(function sort(a, b) {

        a = a[1];
        b = b[1];
        return a < b ? 1 : (a > b ? -1 : 0);
    });

    return this.freeupspacehelper(tuples, cb);
};

/**
 * freeup helper for asnyc space freeup
 */
DiskStore.prototype.freeupspacehelper = function (tuples, cb) {

    // check, if we have any entry to process
    if (tuples.length === 0) {
        return cb(null);
    }

    // get an entry from the list
    var tuple = tuples.pop();
    var key = tuple[0];

    // delete an entry from the store
    this.del(key, function deleted(err) {

        // return when an error occures
        if (err) {
            return cb(err);
        }

        // stop processing when enouth space has been cleaned up
        if (this.currentsize <= this.options.maxsize) {
            return cb(err);
        }

        // ok - we need to free up more space
        return this.freeupspacehelper(tuples, cb);
    }.bind(this));
};

/**
 * get entry from the cache
 */
DiskStore.prototype.get = function (key, options, cb) {

    if (typeof options === 'function') {
        cb = options;
    }

    cb = typeof cb === 'function' ? cb : noop;

    // get the metadata from the collection
    var data = this.collection[key];

    if (!data) {

        // not found
        return cb(null, null);
    }

    // found but expired
    if (data.expires < new Date()) {

        // delete the elemente from the store
        this.del(key, function (err) {
            return cb(err, null);
        });
    } else {

        // try to read the file
        try {

            fs.readFile(data.filename, function (err, fileContent) {
                if (err) {
                    return cb(err);
                }
                var reviveBuffers = this.options.reviveBuffers;
                var binaryAsStream = this.options.binaryAsStream;
                var zipOption = this.options.zip;
                async.waterfall(
                    [function (seriescb) {
                        if (zipOption) {
                            zlib.unzip(fileContent, function (err, buffer) {
                                var diskdata;
                                if (reviveBuffers) {
                                    diskdata = JSON.parse(buffer, bufferReviver);
                                } else {
                                    diskdata = JSON.parse(buffer);
                                }
                                seriescb(null, diskdata);
                            });
                        }
                        else {
                            var diskdata;
                            if (reviveBuffers) {
                                diskdata = JSON.parse(fileContent, bufferReviver);
                            } else {
                                diskdata = JSON.parse(fileContent);
                            }
                            seriescb(null, diskdata);
                        }
                    },
                    function (diskdata, seriescb) {
                        if (diskdata && diskdata.value && diskdata.value.binary && diskdata.value.binary != null && typeof diskdata.value.binary == 'object') {
                            async.forEachOf(diskdata.value.binary, function (v, k, cb) {
                                diskdata.value.binary[k] = fs.createReadStream(v, {
                                    autoClose: true,
                                    encoding: null
                                });
                                if (binaryAsStream) {
                                    cb();
                                } else {
                                    var bufs = [];
                                    diskdata.value.binary[k].on('data', function (d) {
                                        bufs.push(Buffer(d));
                                    });
                                    diskdata.value.binary[k].on('error', function (err) {
                                        cb(err);
                                    });
                                    diskdata.value.binary[k].on('end', function () {
                                        diskdata.value.binary[k] = Buffer.concat(bufs);
                                        cb();
                                    });
                                }
                            }, function (err) {
                                if (err)
                                    return seriescb(err);
                                seriescb(null, diskdata.value);
                            });
                        } else {
                            seriescb(null, diskdata.value);
                        }
                    }], function(err, result){
                        cb(err, result);
                    })
            }.bind(this));

        } catch (err) {

            cb(err);
        }
    }
};

/**
 * get keys stored in cache
 * @param {Function} cb
 */
DiskStore.prototype.keys = function (cb) {

    cb = typeof cb === 'function' ? cb : noop;

    var keys = Object.keys(this.collection);

    cb(null, keys);
};

/**
 * cleanup cache on disk -> delete all used files from the cache
 */
DiskStore.prototype.reset = function (key, cb) {

    cb = typeof cb === 'function' ? cb : noop;

    if (typeof key === 'function') {
        cb = key;
        key = null;
    }

    if (Object.keys(this.collection).length === 0) {
        return cb(null);
    }

    try {

        // delete special key
        if (key !== null) {

            this.del(key);
            return cb(null);
        }

        async.eachSeries(this.collection,
            function (elementKey, callback) {
                this.del(elementKey.key, callback);
            }.bind(this),
            function (err) {
                cb(null);
            }.bind(this)
        );

    } catch (err) {

        return cb(err);
    }

};

/**
 * helper method to clean all expired files
 */
DiskStore.prototype.cleanExpired = function () {

    var key, entry;

    for (key in this.collection) {

        entry = this.collection[key];

        if (entry.expires < new Date()) {

            this.del(entry.key);
        }
    }
}

/**
 * clean the complete cache and all(!) files in the cache directory
 */
DiskStore.prototype.cleancache = function (cb) {

    cb = typeof cb === 'function' ? cb : noop;

    // clean all current used files
    this.reset();

    // check, if other files still resist in the cache and clean them, too
    var files = fs.readdirSync(this.options.path);

    files
        .map(function (file) {

            return path.join(this.options.path, file);
        }.bind(this))
        .filter(function (file) {

            return fs.statSync(file).isFile();
        }.bind(this))
        .forEach(function (file) {

            fs.unlinkSync(file);
        }.bind(this));

    cb(null);

};

/**
 * fill the cache from the cache directory (usefull e.g. on server/service restart)
 */
DiskStore.prototype.intializefill = function (cb) {

    cb = typeof cb === 'function' ? cb : noop;

    // get the current working directory
    fs.readdir(this.options.path, function (err, files) {

        // get potential files from disk
        files = files.map(function (filename) {

            return path.join(this.options.path, filename);
        }.bind(this)).filter(function (filename) {

            return fs.statSync(filename).isFile();
        });

        // use async to process the files and send a callback after completion
        async.eachSeries(files, function (filename, callback) {

            if (!/\.dat$/.test(filename)) { // only .dat files, no .bin files read
                return callback();
            }

            fs.readFile(filename, function (err, data) {

                // stop file processing when there was an reading error
                if (err) {
                    return callback();
                }
                this.unzipIfNeeded(data, function(err,data) {
                    try {
                        if(err){ // if unzippable - throw to remove
                            throw Error('unzippable: ' + err);
                        }
                        // get the json out of the data
                        var diskdata = JSON.parse(data);

                    } catch (err) {

                        // when the deserialize doesn't work, probably the file is uncomplete - so we delete it and ignore the error
                        try {
                            fs.unlinksync(filename);
                            // unlink binary
                            glob(filename.replace(/\.dat$/, '*.bin'), function (err, result) {
                                if (!err) {
                                    async.each(result, fs.unlink);
                                }
                            });
                        } catch (ignore) {

                        }

                        return callback();
                    }

                    // update the size in the metadata - this value isn't correctly stored in the file
                    // diskdata.size = data.length;

                    // update collection size
                    this.currentsize += diskdata.size;

                    // remove the entrys content - we don't want the content in the memory (only the meta informations)
                    diskdata.value = null;
                    delete diskdata.value;

                    // and put the entry in the store
                    this.collection[diskdata.key] = diskdata;

                    // check for expiry - in this case we instantly delete the entry
                    if (diskdata.expires < new Date()) {

                        this.del(diskdata.key, function () {

                            return callback();
                        });
                    } else {

                        return callback();
                    }
                }.bind(this));
            }.bind(this));

        }.bind(this), function (err) {

            cb(err || null);

        });

    }.bind(this));

};
