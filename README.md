# CTA notifier

Just define the assets you want to monitor in `assets.json` and run `cta-notifier.js` in background
to be notified about new offres published on the marketplace.

As there is no information about assets in an offer except its name and its image URL, this small tool
uses the filename of the URL to match an asset (field `image_filename` in the `assets.json` file).

So, for example, to monitor a rank 2 standard exclusive Phoenix card use `194-fire-2-null-1.png`
where `194` is the card ID and `2` is the rank.
