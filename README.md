# cache-manager-fs-binary

Node Cache Manager store for Filesystem with binary data
========================================================

The Filesystem store for the [node-cache-manager](https://github.com/BryanDonovan/node-cache-manager) module, storing binary data as separate files, returning them as readable streams or buffers.
This should be convenient for caching binary data and sending them as streams to a consumer, e.g. `res.send()`.
The library caches on disk arbitrary data, but values of an object under the special key `binary` is stored as separate files.

Node.js versions
----------------

Works with versions 4, 5 and iojs.

Installation
------------

```sh
    npm install cache-manager-fs-binary --save
```

Usage examples
--------------

Here are examples that demonstrate how to implement the Filesystem cache store.


## Features

* limit maximum size on disk
* refill cache on startup (in case of application restart)
* returns binary data as buffers or readable streams (keys of the `binary` key)
* can store buffers inside the single cache file (not keys of the `binary` key)

## Single store

```javascript
// node cachemanager
var cacheManager = require('cache-manager');
// storage for the cachemanager
var fsStore = require('cache-manager-fs-binary');
// initialize caching on disk
var diskCache = cacheManager.caching({
    store: fsStore,
    options: {
        reviveBuffers: true,
        binaryAsStream: true,
        ttl: 60 * 60 /* seconds */,
        maxsize: 1000 * 1000 * 1000 /* max size in bytes on disk */,
        path: 'diskcache',
        preventfill: true
    }
});

// ...
var cacheKey = 'userImageWatermarked:' + user.id + ':' + image.id;
var ttl = 60 * 60 * 24 * 7; // in seconds

// wrapper function, see more examples at node-cache-manager
diskCache.wrap(cacheKey,
    // called if the cache misses in order to generate the value to cache
    function (cacheCallback) {
        var image; // buffer that will be saved to separate file
        var moreData; // string that will be saved to a separate file
        var userLastVisit; // Date
        var signature; // small binary data to store inside as buffer

        // ... generating the image

        // now returning value to cache and process further
        cacheCallback(err,
// Some JSONable object. Note that null and undefined values not stored.
// One can redefine isCacheableValue method to tweak the behavior.
            {
                binary: {
// These will be saved to separate files and returned as buffers or
// readable streams depending on the cache settings.
// **NB!** The initial values will be changed to buffers or readable streams
// for the sake of simplicity, usability and lowering the memory footprint.
// Check that the keys are suitable as parts of filenames.
                    image: image,
                    someOtherBinaryData: moreData
                },
// Other data are saved into the main cache file
                someArbitraryValues: {
                    eg: userLastVisit
                },
                someSmallBinaryValues: {
// While buffer data could be saved to the main file, it is strongly
// discouraged to do so for large buffers, since they are stored in JSON
// as Array of bytes. Use wisely, do the benchmarks, mind inodes, disk
// space and performance balance.
                    pgpSignatureBufferForm: signature
                }
            });
    },
// Options, see node-cache-manager for more examples
    {ttl: ttl},
// Do your work on the cached or freshly generated and cached value.
// Note, that result.binary.image will come in readable stream form
// in the result, if binaryAsStream is true
    function (err, result) {

        res.writeHead(200, {'Content-Type': 'image/jpeg'});
        var image = result.binary.image;

        image.pipe(res);

        var usedStreams = ['image'];
        // you have to do the work to close the unused files
        // to prevent file descriptors leak
        for (var key in result.binary) {
            if (!result.binary.hasOwnProperty(key))continue;
            if (usedStreams.indexOf(key) < 0
                && result.binary[key] instanceof Stream.Readable) {
                if(typeof result.binary[key].close === 'function') {
                    result.binary[key].close(); // close the stream (fs has it)
                }else{
                    result.binary[key].resume(); // resume to the end and close
                }
            }
        }
    }
)
```

### Options

options for store initialization

```javascript

    // default values
    
    // time to live in seconds
    options.ttl = 60;
    // path for cached files
    options.path = 'cache/';
    // prevent filling of the cache with the files from the cache-directory
    options.preventfill = false;
    // callback fired after the initial cache filling is completed
    options.fillcallback = null;
    // if true the main cache files will be zipped (not the binary ones)
    options.zip = false;
    // if true buffers not from binary key are returned from cache as buffers,
    // not objects
    options.reviveBuffers = false;
    // if true, data in the binary key are returned as StreamReadable and 
    // (**NB!**) the source object will also be changed. 
    // You have to do the work for closing the files if you do not read them,
    // see example.
    options.binaryAsStream = false;

```
	
## Tests

To run tests:

```sh
    npm test
```

## Code Coverage

To run Coverage:

```sh
    npm run coverage
```

## License

cache-manager-fs-binary is licensed under the MIT license.

## Credits

Based on https://github.com/hotelde/node-cache-manager-fs
