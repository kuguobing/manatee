---
title: Manatee
markdown2extras: wiki-tables, code-friendly
apisections:
---

# Manatee - Postgres HA Cluster.

This document describes the high level design for Manatee - A system built on
top of Postgres synchronous replication to deliver a Postgres cluster that is
consistent whilst maximizing availability.

# Background

It's assumed readers are familiar with Zookeeper and Postgres. Read through
[this](http://zookeeper.apache.org/doc/trunk/zookeeperOver.html) Zookeeper guide
before starting this document.

Postgres offers synchronous and asynchronous streaming replication. For a
detailed look, check out the Postgres
[docs](http://www.Postgresql.org/docs/9.1/interactive/warm-standby.html#SYNCHRONOUS-REPLICATION)
on this subject matter.

## Brief Overview of Postgres Synchronous Replication

In this scheme, there are 2 Postgres peers, a primary and a standby. The standby
operates in read-only mode whilst the primary takes all of the writes. Each
commit of a write transaction will wait until confirmation is received that the
commit has been written to the transaction log of both the primary and the standby.

Responses to the client on writes made to the primary will wait until the
standby responds. The response may never occur if the standby crashes.
Regardless of whether the standby responds, the record will be written to the
primary. From the point of view of the client, the response is
indistinguishable from a 500, and the client will not know for certain whether
the write request has succeeded.

Basically, the default Postgres implementation of synchronous replication
results in inconsistency between the client and Postgres on standby failures.
Postgres' solution to this is achieved by adding multiple potential synchronous
standbys.  The first one in the list will be used as the synchronous standby.
Standbys listed after this will take over as the synchronous standby should the
first one fail.

This default setup is insufficient when the primary fails.
Postgres does not provide automatic primary failover, which results in the loss
of write availability until an operator can be engaged.

## The Number 3

If a Postgres Shard is provisioned with 3 Peers, one primary,
one synchronous standby and one asynchronous standby, the Shard can tolerate the
loss of any 1 Peer without becoming unavailable. Unfortunately, adding more
Peers past 3 to a Shard does not increase the availability of a Shard. If at
anytime, the primary and synchronous standby become unavailable, regardless of
the number of the Peers, the Shard becomes unavailable as all other peers are
asynchronous standbys and thus cannot be guaranteed to be up to date.

# Design Goals

A Postgres shard consisting of 3 peers must be able to:

1. Provide group membership discovery to clients.
2. Remain available to writes/reads in the face of failure of any 1 peer -
Specifically, re-assigning the role of the primary to the standby peer in the
face of primary failure.
3. Automate peer recovery - If a peer is down for an amount of time that exceeds
the WAL cache, backup/restore from another peer should be automatic.

With these goals in mind, we can ensure Manatee will be available, consistent,
and partition tolerant as long as each shard doesn't lose more than 1 out of its
3 peers.

All bets are off if we lose more than 1. In this case, the shard will remain in
readonly mode until operator intervention.

# Overview

Manatee consists of the following logical components:

- Zookeeper.
- Postgres.
- Backup/Restore agent.
- Postgres Sitter.
- Registrar Service.

![Alt text](https://www.evernote.com/shard/s2/sh/ccfc9fd4-33cd-41ff-a4b4-d42e8d82928b/86a8b088197189b02e11c8c15f6d287d/res/3eaa0165-23a1-4069-92b1-b926146b353c/Manatee_Components-20120501-155449.jpg.jpg "Manatee Component Diagram")

# Zookeeper

Zookeeper is used for the following tasks:

1. Liveliness checks of Peers within a shard.
2. Primary election of Peers within a shard.
3. Discovery of Shards by Manatee clients.

Tasks 1 and 2 are described in the Postgres Sitter section, whilst task 3 is
described in the Registrar Service section.

# Shards and Peers

A Postgres Shard in Manatee is uniquely identified by a GUID.
The Shard consists of 3 mirrored Postgres instances, henceforth known as Peers.
Shard membership is stored under a configurable persistent znode under
the Zookeeper path:

    /shards/

While each shard entry is stored under the shard path as an emphemeral znode:

    /shards/8d7bda74-7495-4765-80ad-87a1f99ef173
    /shards/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc

Each shard entry contains the following JSON object:

    {
      primary: 'postgres://user@ip:port/db',
      sync: 'postgres://user@ip:port/db',
      async: 'postgres://user@ip:port/db'
    }

The shard entry is updated/created by the current primary in the shard. As group
memberships change, the entry will be updated accordingly.

# Registrar Service

This is the external REST service that allows clients to query for the current
status of all Postgres Shards in Manatee. Note we could have consumers of
Manatee directly query Zookeeper, (which would have the benefit of push
notifications). However, the REST service allows us to reduce the load to
Zookeeper.

Internally the Registrar service maintains a connection to Zookeeper and updates
the shards when changes occur.

## GET /shards

Returns a list of shard URIs.

## GET /shards/:uuid

Returns a shard entry in the format described in the previous section.

## Clients

Clients should maintain a cache of the list of shards. The cache can be configured
with a TTL. If 500s are received from a particular Postgres shard, e.g.
the primary is unavailable, or no longer the primary, then the client should
refresh its cache by querying the Registrar Service.

# Restore Service

This is an internal REST service that allows peers in each shard to recover or
bootstrap themselves from another peer in the service.  This service is only
used when the recovery of a peer from just WAL is not possible. e.g. database
corruption, WAL cache exhaustion, or whilst bootstrapping a new peer. The backup
and restore mechanism relies on ZFS snapshots of the db data dir, and utilizes
@JWilsdon's ZFS send/recv lib for transport.

This service is made up of the following components on each Postgres Peer:

- A snapshot agent that takes periodic ZFS snapshots of the db dir.
- A REST service that takes backup requests.
- A restore agent that sends the snapshot to the requestor.

The backup process is asynchronous:

1. Client POSTS to /backup/ to indicate a backup request.
2. The service creates /backup/uuid and returns this URI to the client.
3. The service initiates ZFS send/recv to the client.
4. The client polls /backup/uuid for the status of the backup.
5. Once the backup has successfully completed, the service updates
/backup/uuid to done status.
6. The client polls /backup/uuid and discovers the backup has finished
succesfully.

In practice, backup requests will only be sent to the primary peer of a shard.

# Postgres Sitter

## Postgres Replication Recap

It's important to note that the change of a Postgres' instance's replication
state i.e. from standby to primary, or primary to standby, requires a restart
of the Postgres instance.  In addition, the primary Postgres instance requires
the URLs of all standby hosts, and each standby host requires the URL of the
primary.  The distinction of whether a standby is synchronous or asynchronous
is soley made on the primary as the standbys have the same configuration
regardess of their replication mode.

## Overview

The Postgres sitter is an agent co-located with each Postgres Peer.

The sitter is responsible for:

- Replication role (primary, standby) determination.
- Postgres initialization.
- Start/stop Postgres.
- Restore/bootstrap a corrupt Postgres Peer.
- Postgres health check.
- Primary failover.
- Primary leader election.

The Postgres instance can only be started/stopped by the Sitter, at no time can
Postgres start/stop on its own. The Sitter is only changing replication role
state of the peers in the event of a primary failure, and not in the event of
standby failures. This is described in further detail in the failure section.

The responsibilities of the Sitter is best described via examples.

## Bootstrapping 3 new Peers into a Shard

Let's call the 3 sitters A, B, and C which belong to shard
3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc. Bootstrapping occurs this way:

- The standard [zookeeper election algorithm](http://zookeeper.apache.org/doc/trunk/recipes.html#sc_leaderElection) is execute on all 3 sitters.
- The leader becomes primary.
- The remaining two peers become the sync and async standbys, depending on who
had the smaller sequence.
- The primary initializes its Postgres instance.
- The standbys initiate db restoration by calling the Restore service.
- After successful restores, the standbys start their Postgres instance.
- The primary checks the status of replication via the pg\_stat\_replication table.
- If replication has been successfully setup, the primary publishes group
membership to the Registrar service. This indicates to clients that this Shard
is ready to take writes.

Elaborating on the election process:

Each peer creates an ephemeral and sequence znode under the path

    /shard/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc/shard-

with their Postgres url as the data. This results in the following state in
Zookeeper:

    /shard/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc/shard-00000 -> {A.url}
    /shard/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc/shard-00001 -> {B.url}
    /shard/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc/shard-00002 -> {C.url}

Each peer then sets a watch on the path

    /shard/3e051a10-4ab9-4aee-a2bf-0a0efd9c85cc/

and is notified of any changes to that path. The roles of the Shard is
determined by the sequence number of each Peer's znode, in ascending order.
With this example, A becomes the primary, B becomes the synchronous standby, and
C becomes the asynchronous standby.

## Failure of a Single Peer in a Shard.

Each Shard can tolerate failures of any single Peer in the Shard. With the
exception of a primary failure, the Sitter does not actively participate in the
failover process. Postgres will automatically promote the asynchronous standby
to synchronous should the synchronous standby fail as part of its replication
process. The Sitter periodically checks the health status of Postgres along
with its session to Zookeeper. If either returns error, the Sitter shuts down
Postgres and disconnects its session from Zookeeper.

### Primary Fails

The Sitters on both the synchronous and asynchronous standby, due to their
watches on the primary's Zookeeper znode, will be notified that the primary is
offline. Both standbys are also aware of who the synchronous standby by checking
with the registrar service. The synchronous standby assumes the role of primary,
and the async becomse the synchronous standby. This is only case where there
will be a small window of time where writes will return 500s.

### Synchronous Standby Fails

The primary will automatically fail over to the asynchronous standby.
The asynchronous standby now assumes the role of the synchronous standby. The
Sitter on the primary will update the shard info in Zookeeper under
/shards/shardid to reflect the new membership of the shard.

### Asynchronous Standby Fails

If the asynchronous standby is unavailable, no Postgres actions are taken. The
Sitter on the primary will update the shard info in Zookeeper to reflect the
loss of the asynchronous peer.

## Inserting a new Peer into a Shard

Inserting works with the following algorithm:

- Perform leader election, i.e. set a watch and create an emphemeral-sequence
znode under the shard path. If there were any other peers in the shard before
you joined, you would not become leader because you would have a higher
sequenced znode.
- If you are the leader, then the process is the same as the bootstrap process
described earlier.
- If you are not the leader, then join the shard as a standby. Note you do not
determine whether you are the async or sync standby, you merely replicate from
the primary and the primary will determine your standby role.
