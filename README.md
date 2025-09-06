# Kinopio Glue

Glue is a task collator for [Kinopio](https://kinopio.club) that collects all tasks across all spaces and sorts them into lists, filterable by url flags for spaces and groups of spaces.

This project is in its infancy and was written by someone with very limited programming experience. I'm much more of an IT person or designer/artist, so please use it at your own risk.

You can follow the development in [this Kinopio space](https://kinopio.club/kn-glue-No2GvJ3kD7NUnJxihn6LG).

---

## Running

Couldn't be simpler: Define your `KINOPIO_API_KEY` in your environment, clone the repo, and run `node server.js`.

You should only run this on a server that you own, like on your own computer, and under no circumstances expose this service to the internet; It's not built for that. I personally run this on a mac mini in a basement that allows me to access it remotely with a virtual local network via [Tailscale](https://tailscale.com/).
