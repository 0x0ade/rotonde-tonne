var version = '0.2.2';

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

var feeds = {};

fs.mkdir(root, async (err) => {
    if (err && err.code !== 'EEXIST') throw err;

    fs.mkdirSyncNexist(path.resolve(root, 'media'));
    fs.mkdirSyncNexist(path.resolve(root, 'media', 'content'));
    fs.mkdirSyncNexist(path.resolve(root, 'media', 'content', 'inline'));
    fs.mkdirSyncNexist(path.resolve(root, 'links')); 

    Dat(root, config.tonne.datopts || {}, (err, dat_) => {
        if (err) throw err;
        dat = dat_;
        dat.importFiles({watch: true});
        dat.joinNetwork((err) => {
            if (err) throw err;
            main();
        });
    });
});

function save(sync = true) {
    fs.writeFileSync(path.resolve(root, 'portal.json'), JSON.stringify(portal));
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
    console.log('Connected to dat network', `dat://${hash}/`);

    var firstTime = false;
    try {
        portal = JSON.parse(fs.readFileSync(path.resolve(root, 'portal.json')));
    } catch (err) {
        // If it's our first time, save & sync after connecting.
        firstTime = true;
        firstTimeSetup();
    }
    tonne = portal.tonne;
    
    portal.client_version = `tonne: ${version}`;
    
    await initTwitter();

    fs.writeFileSync(path.resolve(root, 'dat.json'), JSON.stringify({
        url: `dat://${hash}/`,
        title: `@${tonne.twitter.handle}/tonne`,
        description: "rotonde ⇄ twitter"
    }));

    if (firstTime)
        save();
    
    fs.mkdirSyncNexist('tmp');
    config.tonne.feeds.forEach(feedKey => {
        var feedRoot = path.resolve('tmp', feedKey);
        fs.mkdirSyncNexist(feedRoot);
        Dat(feedRoot, { key: feedKey, temp: true/*, sparse: true*/ }, (err, feedDat) => {
            if (err) {
                // Failed connecting? Just notify the user.
                console.error('Failed connecting to rotonde feed', feedKey, err);
                return;
            }
            console.log('Connected to portal', `dat://${feedKey}/`);
            // We're already connected to the network - we only want to download.
            feedDat.joinNetwork({ upload: false });

            var stats = feedDat.trackStats();
            feeds[feedKey] = { newest: Date.now(), dat: feedDat, stats: stats, root: feedRoot };                
            stats.on('update', () => rotondeUpdated(feedKey, feedDat));
        });
    });

    connectTwitter();
}

function firstTimeSetup() {
    portal = {
        name: '???/tonne',
        desc: 'rotonde ⇄ twitter',
        port: [],
        feed: [],
        site: '',
        dat: '', // Deprecated

        tonne: { }
    };
}


async function rotondeUpdated(feedKey, feedDat) {
    // fs.readFile(path.resolve(feeds[feedKey].root, 'portal.json'), (err, feedFile) => {
    feedDat.archive.readFile('/portal.json', async (err, feedFile) => {
        // console.log('Rotonde feed updated', feedKey);
        if (err) {
            console.error('Failed reading rotonde feed', feedKey, err);
            return;
        }
        var feed;
        try {
            feed = JSON.parse(feedFile);
        } catch (err) {
            console.error('Failed parsing rotonde feed', feedKey, err);
            return;
        }

        var entry;
        var now = Date.now();
        feed.feed.forEach(feedEntry => {
            if (feedEntry.timestamp <= feeds[feedKey].newest ||
                now < feedEntry.timestamp)
                return;
            feeds[feedKey].newest = feedEntry.timestamp;
            entry = feedEntry;
        });

        if (!entry || entry.whisper || entry.message.indexOf(config.tonne.nomirror))
            return;
        
        console.log('Found new newest rotonde entry', entry);

        var args = { status: entry.message };

        if (entry.quote && hasHash(entry.target, hash) && entry.media == entry.quote.media &&
            entry.media.startsWith('twttr#@')) {
            var meta = entry.media.substring('twttr#@'.length, entry.media.length - 2).split('/');
            if (meta.length < 3)
                return;
            
            var id = meta[2];
            var up;
            try {
                up = await getTweet(id);
                if (!up)
                    throw null;
            } catch (err) {
                // Fail silently.
                return;
            }

            var author = '@' + up.user.screen_name;
            var us = '@' + tonne.twitter.handle;
            
            var mentions = '';
            if (!entry.message.startsWith('@')) {
                var words = getTweetText(up).split(' ');
                for (var i in words) {
                    var word = words[i];
                    if (!word.startsWith('@'))
                        break;
                    if (word == author ||
                        word == us)
                    continue;
                    mentions += word;
                    mentions += ' ';
                }
            }
            args.status = mentions + args.status;

            if (args.status.indexOf(author) == -1)
                args.status = author + ' ' + args.status;
            
            args.in_reply_to_status_id = id;
        } else if (entry.quote || entry.media)
            return;

        twitter.post('statuses/update', args, function(err, tweet, raw) {
            if (err) {
                console.error('Failed sending tweet', err);
                return;
            }
            console.log('Tweet sent', tweet); 
        });
    })
}


function toHash(url) {
    if (!url)
        return null;

    if (url.startsWith("//"))
        url = url.substring(2);

    url = url.replace("dat://", "");

    var index = url.indexOf("/");
    url = index == -1 ? url : url.substring(0, index);

    url = url.toLowerCase().trim();
    return url;
}

function hasHash(hashesA, hashesB) {
  // Passed a single url or hash as hashesB. Let's support it for convenience.
  if (typeof(hashesB) === 'string')
    return hashesA.findIndex(hashA => toHash(hashA) == toHash(hashesB)) > -1;
  
  for (var a in hashesA) {
    var hashA = toHash(hashesA[a]);
    if (!hashA)
      continue;

    for (var b in hashesB) {
      var hashB = toHash(hashesB[b]);
      if (!hashB)
        continue;

      if (hashA == hashB)
        return true;
    }

  }

  return false;
}


function getEntryIndex(find) {
    return (!find || !find.tonne) ? -1 : portal.feed.findIndex(entry => entry.tonne &&
        entry.tonne.from === find.tonne.from &&
        entry.tonne.id === find.tonne.id
    );
}

function hasEntry(find) {
    return getEntryIndex(find) > -1;
}

function addEntry(entry) {
    if (!entry)
        return;
    var index = getEntryIndex(entry)
    if (index > -1)
        portal.feed[index] = entry;
    else
        portal.feed.push(entry);
    // Oldest top, newest bottom.
    portal.feed = portal.feed.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
    var over = portal.feed.length - config.tonne.max;
    if (over > 0)
        portal.feed.splice(0, over);
}

function getLinkMediaURL(url) {
    if (url.startsWith('https://twitter.com/'))
        return 'twttr#@' + url.substring('https://twitter.com/'.length) + '/.';
    if (url.startsWith('https://t.co/'))
        return 'tco#' + url.substring('https://t.co/'.length) + '/.';
    return 'ext#' + url + '/.';
}

function unescapeHTML(m) {
    return m && m
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, '\'');
}

function escapeHTML(m) {
    return m && m
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


function initTwitter() { return new Promise((resolve, reject) => {
    twitter.get('account/settings', (err, settings, raw) => {
        if (err) reject(err);
        tonne.twitter = tonne.twitter || {};
        tonne.twitter.handle = settings.screen_name;
        portal.name = `${tonne.twitter.handle}/tonne`;
        portal.site = `https://twitter.com/${tonne.twitter.handle}`;
        twitter.get('users/show', { screen_name: tonne.twitter.handle }, (err, user, raw) => {
            tonne.twitter.id = user.id_str;
            console.log('Connected to Twitter', tonne.twitter.handle, tonne.twitter.id);
            resolve();
        });
    });
});}

async function connectTwitter() {
    config.twitter.polls.forEach(src => {
        var args = src.args || {};
        args.tweet_mode = getDefault(args.tweet_mode, 'extended');
        twitter.get(src.endpoint, args, function(err, tweets, raw) {
            if (err) {
                console.error('Failed polling', src.endpoint, err);
                // Fail non-fatally on poll.
                return;
            }
            console.log('Polled', src.endpoint);
            tweets.forEach(tweet => convertTweet(tweet).then(addEntry));
            queueSave();
        });
    });

    config.twitter.streams.forEach(src => {
        var args = src.args || {};
        if (src.endpoint === 'statuses/filter' && src.auto) {
            args.follow = '';
            args.track = '';
            
            src.auto.forEach(auto => {
                if (auto === 'user') {
                    args.follow += tonne.twitter.id;
                    args.follow += ',';
                } else if (auto === 'mentions') {
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
        _twitterStream(src.endpoint, args);
    });
}

async function _twitterStream(endpoint, args) {
    var stream = twitter.stream(endpoint, args);
    stream.on('error', err => {
        if (err.syscall === 'connect') {
            console.error('Failed connecting to Twitter stream, trying again', err);
            setTimeout(() => _twitterStream(endpoint, args), 1000);
            return;
        }
        throw err;
    });
    stream.on('data', event => {
        if (!(event && event.contributors !== undefined && event.id_str && event.user && (event.full_text || event.text))) {
            console.error('Received unknown event in stream', endpoint, event);
            return;
        }
        convertTweet(event).then(addEntry);
        queueSave();
    });
}

function getTweet(id, args) { return new Promise((resolve, reject) => {
    args = args || {};
    args.id = getDefault(args.id, id);
    args.tweet_mode = getDefault(args.tweet_mode, 'extended');
    twitter.get('statuses/show', args, function(err, tweet, raw) {
        if (err) {
            console.error('Failed getting tweet', id, err);
            reject(err);
            return;
        }
        resolve(tweet);
    });
});}

var __snowflakeOffset__ = UINT64('1288834974657');
function snowflakeToTimestamp(id) {
    return UINT64(id).shiftRight(22).add(__snowflakeOffset__).toString();
}
function getTweetURL(tweet) {
    return `https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`;
}
function getTweetText(tweet) {
    if (tweet.extended_tweet)
        return getTweetText(tweet.extended_tweet) || unescapeHTML(tweet.text);
    return unescapeHTML(tweet.full_text || tweet.text);
}
function getTweetHeader(user, icon, did, url) {
    icon = icon ? `{%${icon}.svg%}` : '{%twitter.svg%}';
    if (url)
        icon = `{${icon}|${url}}`;
    did = did ? ` {*${did}*}` : '';
    var header = `${icon} {*${unescapeHTML(user.name)}*} {_@${user.screen_name}_}${did}`;
    return header;
}
function getTweetMessage(tweet, icon, did) {
    return `${getTweetHeader(tweet.user, icon, did, getTweetURL(tweet))}\n${getTweetText(tweet)}`;
}
async function convertTweet(tweet) {
    if (!tweet)
        return null;
    
    var entry;

    if (tweet.retweeted_status) {
        entry = {
            message: getTweetHeader(tweet.user, 'retweet', 'retweeted'),
            media: getLinkMediaURL(getTweetURL(tweet.retweeted_status)),
            tonne: {
                action: 'repost'
            },
            quote: await convertTweet(tweet.retweeted_status)
        };
    
    } else if (tweet.in_reply_to_status_id_str) {
        entry = {
            message: getTweetMessage(tweet, 'twitter', 'replied'),
            media: getLinkMediaURL(getTweetURL(tweet)),
            tonne: {
                action: 'reply'
            }
        };
        try {
            var up = await getTweet(tweet.in_reply_to_status_id_str);
            entry.quote = await convertTweet(up);
        } catch (err) {
            // Silent fail.
            entry.quote = undefined;
        }
    } else if (tweet.quoted_status) {
        entry = {
            message: getTweetMessage(tweet, 'twitter', 'quoted'),
            media: getLinkMediaURL(getTweetURL(tweet)),
            tonne: {
                action: 'quote'
            },
            quote: await convertTweet(tweet.quoted_status)
        };
    
    } else {
        entry = {
            message: getTweetMessage(tweet),
            media: getLinkMediaURL(getTweetURL(tweet)),
            tonne: {
                action: 'post'
            }
        };
    }

    // Fix Rotonde 0.2 requiring target.
    entry.target = [ `dat://${hash}/` ];

    entry.timestamp = snowflakeToTimestamp(tweet.id_str);

    entry.tonne.from = 'twitter';
    entry.tonne.id = tweet.id_str;
    entry.tonne.handle = tweet.user.screen_name;
    entry.tonne.name = tweet.user.name;
    
    return entry;
}
