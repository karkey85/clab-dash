#!/bin/bash

echo "Checking MPLS kernel modules..."

if lsmod | grep -q mpls_router && 
lsmod | grep -q mpls_gso && 
lsmod | grep -q mpls_iptunnel; then
echo "MPLS modules already loaded ✅"
else
echo "Loading MPLS kernel modules..."
sudo modprobe mpls_router
sudo modprobe mpls_gso
sudo modprobe mpls_iptunnel
fi

echo "Current MPLS module status:"
lsmod | grep mpls

