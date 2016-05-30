# node-cache-manager-fs-binary

Node Cache Manager store for Filesystem with binary data
========================================================

The Filesystem store for the [node-cache-manager](https://github.com/BryanDonovan/node-cache-manager) module, storing binary data as separate files, returning them as readable streams or buffers.
This should be convenient for caching binary data and sending them as streams to a consumer, e.g. `res.send()`.
The library caches on disk arbitrary data, but values of an object under the special key `binary` is stored as separate files.

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

## Single store

```javascript

    var streamifier = require('streamifier');
    var Stream = require('stream');
    // node cachemanager
    var cacheManager = require('cache-manager');
    // storage for the cachemanager
    var fsStore = require('cache-manager-fs-binary');
    // initialize caching on disk
    var diskCache = cacheManager.caching({store: fsStore, options: {reviveBuffers: true, binaryAsStream: true, ttl: 60*60 /* seconds */, maxsize: 1000*1000*1000 /* max size in bytes on disk */, path:'diskcache', preventfill:true}});
    
    // ...
    var cacheKey = 'userImageWatermarked:' + user.id + ':' + image.id;
    var ttl = 60*60*24*7; // in seconds
    
    // wrapper function
    diskCache.wrap(cacheKey, 
    function(cacheCallback){ // this function is called if a cache misses to generate the value to cache
        var image; // buffer
        // ... generating the image
        cacheCallback(err, {binary: {image: image, someOtherBinaryData: moreData}, someArbitraryValues: {eg: userLastVisit}, someSmallBinaryValues: {pgpSignatureBufferForm: signature}});
        // Note, you can store any JSONable object, even buffers. Note, that JSON is not the best type for storing buffers, though.
        // Also note that the image and moreData variables will be stored to separate files. Use keys under ['binary'] that are suitable for filenames.
    },
    {ttl: ttl},
    function(err, result){ // do your work on the cached or freshly generated and cached value
        // Note, that result.binary.image may come in original form or returned from cache form.
        // While the former is up to you, the latter could be as buffer or readable stream, depending on the settings
        
        res.writeHead(200, {'Content-Type': 'image/jpeg'});
        var image = (result.binary.image instanceof Stream.Readable)?result.binary.image:streamifier.createReadStream(result.binary.image, {encoding: null});
        
        image.pipe(res);
        
        var usedStreams = ['image'];
        // you have to do the work to close the unused files to prevent file descriptors leak
        for(var key in result.binary){
            if(usedStreams.indexOf(key)<0 && result.binary[key] instanceof Stream.Readable){
                result.binary[key].close();
            }
        }
    }
    )

```

### Options

options for store initialization

```javascript

    options.ttl = 60; // time to life in seconds
    options.path = 'cache/'; // path for cached files
    options.preventfill = false; // prevent filling of the cache with the files from the cache-directory
    options.fillcallback = null; // callback fired after the initial cache filling is completed
    options.zip = false; // if true the cached files will be zipped to save diskspace
    options.reviveBuffers = true; // if true buffers are returned from cache as buffers, not objects
    options.binaryAsStream = true; // if true, data in the binary key are returned as StreamReadable of the binary file with autoclose. You have to do the work for closing the files if you do not read them.

```
## Installation

    npm install cache-manager-fs-binary
	
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

Based on https://github.com/hotelde/node-cache-manager-fs
