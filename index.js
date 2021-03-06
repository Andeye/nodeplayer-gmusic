var getConfigPath = function(config) {
	if (process.platform == 'win32')
		return process.env.USERPROFILE + '\\nodeplayer\\' + config;
	else
		return process.env.HOME + '/.' + config;
}

var creds = require(getConfigPath('googlePlayCreds.json'));
var PlayMusic = require('playmusic');
var mkdirp = require('mkdirp');
var https = require('https');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');
var stream = require('stream');

var config, player, logger;

var gmusicBackend = {};
gmusicBackend.name = 'gmusic';

// TODO: seeking
var encodeSong = function(origStream, seek, songID, progCallback, errCallback) {
    var incompletePath = config.songCachePath + '/gmusic/incomplete/' + songID + '.opus';
    var incompleteStream = fs.createWriteStream(incompletePath, {flags: 'w'});
    var encodedPath = config.songCachePath + '/gmusic/' + songID + '.opus';

    var command = ffmpeg(origStream)
        .noVideo()
        //.inputFormat('mp3')
        //.inputOption('-ac 2')
        .audioCodec('libopus')
        .audioBitrate('192')
        .format('opus')
        .on('error', function(err) {
            logger.error('error while transcoding ' + songID + ': ' + err);
            if(fs.existsSync(incompletePath))
                fs.unlinkSync(incompletePath);
            errCallback(err);
        })

    var opusStream = command.pipe(null, {end: true});
    opusStream.on('data', function(chunk) {
        incompleteStream.write(chunk, undefined, function() {
            progCallback(chunk.length, false);
        });
    });
    opusStream.on('end', function() {
        incompleteStream.end(undefined, undefined, function() {
            logger.verbose('transcoding ended for ' + songID);

            // TODO: we don't know if transcoding ended successfully or not,
            // and there might be a race condition between errCallback deleting
            // the file and us trying to move it to the songCache

            // atomically move result to encodedPath
            if(fs.existsSync(incompletePath)) {
                fs.renameSync(incompletePath, encodedPath);
                progCallback(0, true);
            } else {
                progCallback(0, false);
            }
        });
    });

    logger.verbose('transcoding ' + songID + '...');
    return function(err) {
        command.kill();
        logger.verbose('canceled preparing: ' + songID + ': ' + err);
        if(fs.existsSync(incompletePath))
            fs.unlinkSync(incompletePath);
        errCallback('canceled preparing: ' + songID + ': ' + err);
    };
};

var gmusicDownload = function(songID, progCallback, errCallback) {
    var req = null;
    var gmusicStream = new stream.PassThrough();

    var doDownload = function(streamUrl) {
        if(streamUrl) {
            logger.debug('downloading song ' + songID);

            req = https.request(streamUrl, function(res) {
                res.pipe(gmusicStream, {end: false});

                res.on('end', function() {
                    if(res.statusCode === 302) { // redirect
                        logger.debug('redirected. retrying with new URL');
                        res.unpipe();
                        doDownload(res.headers.location);
                    } else if (res.statusCode === 200) {
                        logger.debug('download finished');
                        gmusicStream.end();
                    } else {
                        gmusicStream.end();
                        logger.error('unknown status code ' + res.statusCode);
                        if(errCallback)
                            errCallback('unknown status code ' + res.statusCode);
                    }
                });
            });
            req.on('error', function(e) {
                logger.error(e + ' while fetching! reconnecting in 5s...');
                setTimeout(function() {
                    gmusicBackend.init(function() {
                        logger.error('error while fetching! now reconnected to gmusic');
                        gmusicBackend.pm.getStreamUrl(songID, function(streamUrl) {
                            doDownload(streamUrl);
                        }, function(err) {
                            errCallback(err);
                        });
                    });
                }, 5000);
            });
            req.end();
        } else {
            gmusicBackend.pm.getStreamUrl(songID, function(streamUrl) {
                doDownload(streamUrl);
            }, function(err) {
                errCallback(err);
            });
        }
    };

    /*
    return function(err) {
        // TODO: this doesn't seem to work very well...
        if(command)
            command.kill();
        if(req)
            req.abort();

        if(fs.existsSync(filePath))
            fs.unlinkSync(filePath);
        if(fs.existsSync(incompleteFilePath))
            fs.unlinkSync(incompleteFilePath);

        logger.verbose('canceled preparing: ' + songID + ': ' + err);

        errCallback();
    };
    */

    doDownload();

    var cancelEncoding = encodeSong(gmusicStream, 0, songID, progCallback, errCallback);
    return function(err) {
        if(req)
            req.abort();
        cancelEncoding(err);
    };
};

// cache songID to disk.
// on success: progCallback must be called with true as argument
// on failure: errCallback must be called with error message
// returns a function that cancels preparing
gmusicBackend.prepareSong = function(songID, progCallback, errCallback) {
    var filePath = config.songCachePath + '/gmusic/' + songID + '.opus';

    if(fs.existsSync(filePath)) {
        // true as first argument because there is song data
        progCallback(true, true);
    } else {
        return gmusicDownload(songID, progCallback, errCallback);
    }
};

gmusicBackend.isPrepared = function(songID) {
    var filePath = config.songCachePath + '/gmusic/' + songID + '.opus';
    return fs.existsSync(filePath);
};

// search for music from the backend
// on success: callback must be called with a list of song objects
// on failure: errCallback must be called with error message
gmusicBackend.search = function(query, callback, errCallback) {
    gmusicBackend.pm.search(query.terms, Math.min(100, config.searchResultCnt), function(data) {
        var songs;
        var results = {};
        results.songs = {};

        if(data.entries) {
            songs = data.entries.filter(function(entry) {
                return entry.type === '1'; // songs only, no albums/artists
            });

            for(var i = 0; i < songs.length; i++) {
                results.songs[songs[i].track.nid] = {
                    artist: songs[i].track.artist,
                    title: songs[i].track.title,
                    album: songs[i].track.album,
                    albumArt: null, // TODO: can we add this?
                    duration: songs[i].track.durationMillis,
                    songID: songs[i].track.nid,
                    score: songs[i].score,
                    backendName: 'gmusic',
                    format: 'opus'
                };
            }
        }

        callback(results);
    }, function(err) {
        errCallback('error while searching gmusic: ' + err);
    });
};

// called when partyplay is started to initialize the backend
// do any necessary initialization here
gmusicBackend.init = function(_player, _logger, callback) {
    player = _player;
    config = _player.config;
    logger = _logger;

    mkdirp(config.songCachePath + '/gmusic/incomplete');

    // initialize google play music backend
    gmusicBackend.pm = new PlayMusic();
    gmusicBackend.pm.init(creds, callback);
};

module.exports = gmusicBackend;
