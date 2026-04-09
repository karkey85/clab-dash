#!/bin/bash
NODES=("leaf1" "leaf2" "spine1" "spine2")
PREFIX="clab-evpn-lab"

for node in "${NODES[@]}"; do
  echo "---------------------------------------------------"
  echo "Node: $node"
  echo "---------------------------------------------------"
  # Check if Link-Local IPv6 addresses exist
  docker exec ${PREFIX}-${node} ip -6 addr show eth1 | grep fe80
  # Check BGP Summary
  docker exec ${PREFIX}-${node} vtysh -c "show ip bgp summary"
  docker exec ${PREFIX}-${node} vtysh -c "show bgp l2vpn evpn summary"
done
