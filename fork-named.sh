#!/bin/sh
printf 'new branch name (a-z0-9-): '; read name
[ -n "$name" ] && node lfs.mjs fork "$name"
printf '\npress enter'; read _
