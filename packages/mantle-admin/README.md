# @aotter/mantle-admin

Optional Admin composition for Mantle. It owns Admin routes, API projections,
staff gates, and the static asset contract while reusing the same Core runtime
operations and authorization policy as programmatic callers.

Platform adapters supply identity/session resolution, request context, and an
`AdminAssetServer`. Omitting this package mounts no Admin routes and requires
no static assets.
