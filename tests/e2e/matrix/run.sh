#!/bin/bash
# usage: run.sh <script> [docker args...]  — 클린 컨테이너(dev 유저)에서 스크립트 실행
D=$(cd $(dirname $0); pwd); s=$1; shift
docker run --rm "$@" -v $D:/m:ro fg-audit-base bash /m/$s
