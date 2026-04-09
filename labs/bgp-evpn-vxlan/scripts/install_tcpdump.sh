#!/bin/sh

echo "Detecting OS and installing tcpdump..."

if [ -f /etc/os-release ]; then
    . /etc/os-release

    case "$ID" in
        alpine)
            echo "Alpine detected"
            apk add --no-cache tcpdump
            ;;
        debian|ubuntu)
            echo "Debian/Ubuntu detected"
            apt-get update && apt-get install -y tcpdump
            ;;
        *)
            echo "Unknown OS: $ID"
            exit 1
            ;;
    esac
else
    echo "Cannot detect OS"
    exit 1
fi

echo "tcpdump installation completed"
