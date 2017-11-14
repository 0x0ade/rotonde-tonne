var version = '0.0.0';

var cuint = require('cuint');
var UINT32 = cuint.UINT32;
var UINT64 = cuint.UINT64;
var fs = require('fs');
var path = require('path');
var Dat = require('dat-node');
var Twitter = require('twitter');

fs.mkdirSyncNexist = function() {
    try {
        fs.mkdirSync.apply(null, arguments);
    } catch (err) {
        if (err && err.code !== 'EEXIST') throw err;
    }
}

// Node v8 is missing fs.copyFile
function copyFile(source, target) {
    return new Promise(function(resolve, reject) {
        function rejectCleanup(err) {
            rd.destroy();
            wr.end();
            reject(err);
        }
        var rd = fs.createReadStream(source);
        rd.on('error', rejectCleanup);
        var wr = fs.createWriteStream(target);
        wr.on('error', rejectCleanup);
        wr.on('finish', resolve);
        rd.pipe(wr);
    });
}

function getDefault(...args) {
    for (var i in args)
        if (args[i] !== undefined)
            return args[i];
    return undefined;
}

var config = JSON.parse(fs.readFileSync('config.json'));

var twitter = new Twitter(config.twitter.api);

var dat;
var hash;

var root = config.tonne.root || 'tonne';

var portal, tonne;

fs.mkdir(root, async (err) => {
    if (err && err.code !== 'EEXIST') throw err;

    fs.mkdirSyncNexist(path.resolve(root, 'media'));
    fs.mkdirSyncNexist(path.resolve(root, 'media', 'content'));
    fs.mkdirSyncNexist(path.resolve(root, 'media', 'content', 'inline'));
    fs.mkdirSyncNexist(path.resolve(root, 'links'));

    await copyFile(path.resolve('icons', 'icon.svg'), path.resolve(root, 'media', 'content', 'icon.svg'));
    await copyFile(path.resolve('icons', 'retweet.svg'), path.resolve(root, 'media', 'content', 'inline', 'retweet.svg'));    
    await copyFile(path.resolve('icons', 'twitter.svg'), path.resolve(root, 'media', 'content', 'inline', 'twitter.svg'));    

    if (config.tonne.datopts) {
        Dat(root, config.tonne.datopts, (err, dat_) => {
            if (err) throw err;
            dat = dat_;
            dat.joinNetwork((err) => {
                if (err) throw err;
                main();
            });
        });
    } else {
        Dat(root, (err, dat_) => {
            if (err) throw err;
            dat = dat_;
            dat.importFiles();
            dat.joinNetwork((err) => {
                if (err) throw err;
                main();
            });
        });
    }
});

function save(sync = true) {
    fs.writeFileSync(path.resolve(root, 'portal.json'), JSON.stringify(portal));
    if (sync)
        dat.importFiles();
    queuedSave = 0;
}
var queuedSave;
function queueSave() {
    if (queuedSave)
        return;
    queuedSave = setTimeout(() => save(), config.tonne.delay_sync);
}

async function main() {
    if (hash) return;
    hash = dat.key.toString('hex');
    console.log(`Connected as: dat://${hash}/`);

    var firstTime = false;
    try {
        portal = JSON.parse(fs.readFileSync(path.resolve(root, 'portal.json')));
        tonne = portal.tonne;
        console.log('Data loaded. Handle: ', tonne.handle);
    } catch (err) {
        firstTime = true;
        try {
            await firstTimeSetup();
        } catch (err) {
            // Make node.js shut up about the uncatched rejection...
            throw err;
        }
    }

    portal.client_version = `tonne: ${version}`;

    try {
        await connectTwitter();        
    } catch (err) {
        // Make node.js shut up about the uncatched rejection...        
    }

    if (firstTime)
        save();

    config.twitter.polls.forEach(src => {
        var args = src.args || {};
        args.tweet_mode = getDefault(args.tweet_mode, 'extended');
        twitter.get(src.endpoint, args, function(err, tweets, raw) {
            if (err) {
                console.error(err);
                // Fail silently on poll.
            } else {
                tweets.forEach(tweet => convertTweet(tweet));
                queueSave();
            }
        });
    });

    config.twitter.streams.forEach(src => {
        var args = src.args || {};
        if (src.endpoint == 'statuses/filter' && src.auto) {
            args.follow = '';
            args.track = '';
            
            src.auto.forEach(auto => {
                if (auto == 'user') {
                    args.follow += tonne.twitter.id;
                    args.follow += ',';
                } else if (auto == 'mentions') {
                    args.target += '@';
                    args.target += tonne.twitter.handle;
                    args.target += ',';
                } else if (auto.startsWith('follow:')) {
                    args.follow += auto.substring('follow:'.length);
                    args.follow += ',';
                } else if (auto.startsWith('target:')) {
                    args.target += auto.substring('target:'.length);
                    args.target += ',';
                }
            });

            if (args.follow)
                args.follow = args.follow.substring(0, args.follow.length - 1);
            if (args.track)
                args.track = args.track.substring(0, args.track.length - 1);
        }
        args.extended_tweet = getDefault(args.extended_tweet, true);
        var stream = twitter.stream(src.endpoint, args);
        stream.on('error', err => { throw err; });
        stream.on('data', event => {
            if (!(event && event.contributors !== undefined && event.id_str && event.user && (event.full_text || event.text)))
                return;
            convertTweet(event);
            queueSave();
        });
    });
}

function firstTimeSetup() { return new Promise((resolve, reject) => {
    console.log('Performing first time setup...');
    portal = {
        name: '???/tonne',
        desc: 'rotonde ⇄ twitter',
        port: [],
        feed: [],
        site: '',
        dat: '', // Deprecated

        tonne: { }
    };
});}

function connectTwitter() { return new Promise((resolve, reject) => {
    twitter.get('account/settings', (err, settings, raw) => {
        if (err) reject(err);
        tonne.twitter = tonne.twitter || {};
        tonne.twitter.handle = settings.screen_name;
        portal.name = `${tonne.twitter.handle}/tonne`;
        portal.site = `https://twitter.com/${tonne.twitter.handle}`;
        twitter.get('users/show', { screen_name: tonne.twitter.handle }, (err, user, raw) => {
            tonne.twitter.id = user.id_str;
            console.log('Connected to Twitter as ', tonne.twitter.handle, tonne.twitter.id);
            resolve();
        });
    });
});}

function hasEntry(from, id) {
    return portal.feed.findIndex(entry => entry.tonne &&
        entry.tonne.from == from &&
        entry.tonne.id == id
    ) > -1;
}

function makeEntry(from, id, entry) {
    entry.tonne = entry.tonne || {};
    entry.tonne.from = from;
    entry.tonne.id = id;
    return entry;
}

function addEntry(from, id, entry) {
    if (hasEntry(from, id))
        return;
    entry = makeEntry(from, id, entry);
    portal.feed.push(entry);
    // Oldest top, newest bottom.
    portal.feed = portal.feed.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
    var over = portal.feed.length - config.tonne.max;
    if (over > 0)
        portal.feed.splice(config.tonne.max - 1, over);
}

function unescapeHTML(m) {
    return m && m
        .replace('&amp;', '&')
        .replace('&lt;', '<')
        .replace('&gt;', '>')
        .replace('&quot;', '"')
        .replace('&#039;', '\'');
}

var __snowflakeOffset__ = UINT64('1288834974657');
function snowflakeToTimestamp(id) {
    return UINT64(id).shiftRight(22).add(__snowflakeOffset__).toString();
}
function getTweetText(tweet) {
    if (tweet.extended_tweet)
        return getTweetText(tweet.extended_tweet) || unescapeHTML(tweet.text);
    return unescapeHTML(tweet.full_text || tweet.text);
}
function getTweetHeader(user, tweet, icon, did) {
    icon = icon ? `{%${icon}.svg%}` : '{%twitter.svg%}';
    did = did ? ` {*${did}*}` : '';
    var header = `${icon} {*${unescapeHTML(user.name)}*} {_@${user.screen_name}_}${did}`;
    if (tweet) {
        header += ` - {_ https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str} _}`;
    }
    return header;
}
function getTweetMessage(tweet, icon, did) {
    return `${getTweetHeader(tweet.user, tweet, icon, did)}\n${getTweetText(tweet)}`;
}
function convertTweet(tweet) {
    var entry = {
        message: getTweetMessage(tweet),
        timestamp: snowflakeToTimestamp(tweet.id_str),
        // target: [ `https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}` ],
        media: '',
        tonne: {
            handle: tweet.user.screen_name,
            name: tweet.user.name,
            action: 'post'
        }
    };

    // Quote current entry.
    if (tweet.quoted_status) {
        entry.message = getTweetMessage(tweet.quoted_status);
        entry.timestamp = snowflakeToTimestamp(tweet.quoted_status.id_str);
        // entry.target = [ `https://twitter.com/${tweet.quoted_status.user.screen_name}/status/${tweet.quoted_status.id_str}` ];
        entry.tonne.handle = tweet.quoted_status.user.screen_name;
        entry.tonne.name = tweet.quoted_status.user.name;

        entry = {
            message: getTweetMessage(tweet, 'retweet', 'quoted'),
            timestamp: snowflakeToTimestamp(tweet.id_str),
            // Breaks retweet icon.
            // target: [ `https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}` ],
            media: '',
            quote: makeEntry('twitter', tweet.quoted_status.id_str, entry),
            tonne: {
                handle: tweet.user.screen_name,
                name: tweet.user.name,
                action: 'quote'
            }
        };

    } else if (tweet.retweeted_status) {
        entry.message = getTweetMessage(tweet.retweeted_status);
        entry.timestamp = snowflakeToTimestamp(tweet.retweeted_status.id_str);
        // entry.target = [ `https://twitter.com/${tweet.retweeted_status.user.screen_name}/status/${tweet.retweeted_status.id_str}` ];
        entry.tonne.name = tweet.retweeted_status.user.screen_name;
        entry.tonne.name = tweet.retweeted_status.user.name;
        
        entry = {
            message: getTweetHeader(tweet.user, tweet.retweeted_status, 'retweet'),
            timestamp: snowflakeToTimestamp(tweet.id_str),
            // Breaks retweet icon.        
            // target: [ `https://twitter.com/${tweet.retweeted_status.user.screen_name}/status/${tweet.retweeted_status.id_str}` ],
            media: '',
            quote: makeEntry('twitter', tweet.retweeted_status.id_str, entry),
            tonne: {
                handle: tweet.user.screen_name,
                name: tweet.user.name,
                action: 'repost'
            }
        };
    }

    addEntry('twitter', tweet.id_str, entry);
}
