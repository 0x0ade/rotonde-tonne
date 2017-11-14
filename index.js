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
    await copyFile(path.resolve('icons', 'retweet.svg'), path.resolve(root, 'media', 'content', 'inline', 'retweet.svg'));    

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

function save() {
    fs.writeFileSync(path.resolve(root, 'portal.json'), JSON.stringify(portal));
    dat.importFiles();
}

async function main() {
    if (hash) return;
    hash = dat.key.toString('hex');
    console.log(`Connected as: dat://${hash}/`);

    try {
        portal = JSON.parse(fs.readFileSync(path.resolve(root, 'portal.json')));
        tonne = portal.tonne;
        console.log('Data loaded. Handle: ', tonne.handle);
    } catch (err) {
        try {
            await firstTimeSetup();
        } catch (err) {
            // Make node.js shut up about the uncatched rejection...
            throw err;
        }
        save();
    }
    portal.client_version = `tonne: ${version}`;

    portal.feed = [];
    var configPoll = config.twitter.poll || {};
    configPoll.tweet_mode = getDefault(configPoll.tweet_mode, 'extended');
    config.tonne.timelines.forEach(timelineName => {
        twitter.get(`statuses/${timelineName}_timeline`, configPoll, function(err, tweets, raw) {
            if (err) {
                console.error(err);
            } else {
                tweets.forEach(tweet => convertTweet(timelineName, tweet));
                save();
            }
        });
    });

    var configStream = config.twitter.stream || {};
    configStream.replies = getDefault(configStream.replies, true);
    configStream.delimited = getDefault(configStream.delimited, false);
    configStream.extended_tweet = getDefault(configStream.extended_tweet, true);
    var stream = twitter.stream('user', configStream);
    stream.on('error', err => { throw err; });
    stream.on('data', event => {
        if (!(event && event.contributors !== undefined && event.id_str && event.user && event.text))
            return;
        convertTweet('stream', event);
        save();
    });
}

function firstTimeSetup() { return new Promise((resolve, reject) => {
    console.log('Performing first time setup...');

    portal = {
        name: 'tonne',
        desc: 'rotonde ⇄ twitter',
        port: [],
        feed: [],
        site: '',
        dat: '', // Deprecated

        tonne: {
            handle: '@'
        }
    };
    tonne = portal.tonne;

    twitter.get('account/settings', (err, settings, raw) => {
        if (err) reject(err);
        tonne.handle = settings.screen_name;
        tonne.id = settings.id_str;
        portal.name = `${tonne.handle}/tonne`
        portal.site = `https://twitter.com/${tonne.handle}`;
        console.log('First time setup succeeded. Handle: ', tonne.handle);
        resolve();
    });
});}

function hasEntry(from, type, id) {
    return portal.feed.findIndex(entry => entry.tonne &&
        entry.tonne.from == from &&
        entry.tonne.type == type &&
        entry.tonne.id_str == id
    ) > -1;
}

function makeEntry(from, type, id, entry) {
    entry.tonne = entry.tonne || {};
    entry.tonne.from = from;
    entry.tonne.type = type;
    entry.tonne.id = id;
    return entry;
}

function addEntry(from, type, id, entry) {
    if (hasEntry(from, type, id))
        return;
    entry = makeEntry(from, type, id, entry);
    portal.feed.push(entry);
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
function convertTweet(timelineName, tweet) {
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
            quote: makeEntry('twitter', timelineName, tweet.quoted_status.id_str, entry),
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
            quote: makeEntry('twitter', timelineName, tweet.retweeted_status.id_str, entry),
            tonne: {
                handle: tweet.user.screen_name,
                name: tweet.user.name,
                action: 'repost'
            }
        };
    }

    addEntry('twitter', timelineName, tweet.id_str, entry);
}
