# rotonde-tonne
### rotonde ⇄ twitter
#### MIT-licensed
----

## Special thanks to my [patrons on Patreon](https://www.patreon.com/0x0ade):
* [Chad Yates](https://twitter.com/ChadCYates)
* [Renaud Bédard](https://twitter.com/renaudbedard)
* [Artus Elias Meyer-Toms](https://twitter.com/artuselias)

## Instructions:
* Create application at https://apps.twitter.com/
* Rename `config_example.json` to `config.json`
* Fill out `config.json`
    * `config_example.json` is set up to only poll your mentions timeline. All possible timelines are `"home", "user", "mentions"`
    * For `"endpoint": "statuses/filter"`, you can pass `"auto": [ "user", "mentions", "follow:ID", "track:KEYWORD" ]`. rotonde-tonne creates a matching full request.
        * `"user"` and `"mentions"` will be replaced with your ID and handle automatically.
        * `"follow:ID"` and `track:KEYWORD` adhere to the [limits of the Twitter API.](https://developer.twitter.com/en/docs/tweets/filter-realtime/api-reference/post-statuses-filter.html)
    * If you're a fan of manual setup, you can just pass on the args. For example, the following stream mirrors your complete timeline: `{ "endpoint": "user", "args": { "replies": true } }`
* `npm install`
* `npm start`
* Follow the dat from your own portal and hope that Twitter doesn't disconnect you prematurely.

It's just meant to fit my needs. If there's anything missing, please tell me [on Twitter](https://twitter.com/0x0ade) or [Rotonde](dat://rotonde-0x0ade.hashbase.io).

Pull requests are welcome!
