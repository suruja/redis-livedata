/**
 * Provide a synchronous Collection API using fibers, backed by
 * MongoDB.  This is only for use on the server, and mostly identical
 * to the client API.
 *
 * NOTE: the public API methods must be run within a fiber. If you call
 * these outside of a fiber they will explode!
 */

var path = Npm.require('path');

var Fiber = Npm.require('fibers');
var Future = Npm.require(path.join('fibers', 'future'));

RedisInternals = {};
RedisTest = {};

// This is used to add or remove EJSON from the beginning of everything nested
// inside an EJSON custom type. It should only be called on pure JSON!
var replaceNames = function (filter, thing) {
  if (typeof thing === "object") {
    if (_.isArray(thing)) {
      return _.map(thing, _.bind(replaceNames, null, filter));
    }
    var ret = {};
    _.each(thing, function (value, key) {
      ret[filter(key)] = replaceNames(filter, value);
    });
    return ret;
  }
  return thing;
};

// Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just
// doing a structural clone).
// XXX how ok is this? what if there are multiple copies of MongoDB loaded?
//MongoDB.Timestamp.prototype.clone = function () {
//  // Timestamps should be immutable.
//  return this;
//};

var makeMongoLegal = function (name) { return "EJSON" + name; };
var unmakeMongoLegal = function (name) { return name.substr(5); };

var replaceRedisAtomWithMeteor = function (document) {
//  if (document instanceof MongoDB.Binary) {
//    var buffer = document.value(true);
//    return new Uint8Array(buffer);
//  }
//  if (document instanceof MongoDB.ObjectID) {
//    return new Meteor.RedisCollection.ObjectID(document.toHexString());
//  }
  if (document["EJSON$type"] && document["EJSON$value"]
      && _.size(document) === 2) {
    return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));
  }
//  if (document instanceof MongoDB.Timestamp) {
//    // For now, the Meteor representation of a Mongo timestamp type (not a date!
//    // this is a weird internal thing used in the oplog!) is the same as the
//    // Mongo representation. We need to do this explicitly or else we would do a
//    // structural clone and lose the prototype.
//    return document;
//  }
  return undefined;
};

var replaceMeteorAtomWithRedis = function (document) {
//  if (EJSON.isBinary(document)) {
//    // This does more copies than we'd like, but is necessary because
//    // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually
//    // serialize it correctly).
//    return new MongoDB.Binary(new Buffer(document));
//  }
//  if (document instanceof Meteor.RedisCollection.ObjectID) {
//    return new MongoDB.ObjectID(document.toHexString());
//  }
//  if (document instanceof MongoDB.Timestamp) {
//    // For now, the Meteor representation of a Mongo timestamp type (not a date!
//    // this is a weird internal thing used in the oplog!) is the same as the
//    // Mongo representation. We need to do this explicitly or else we would do a
//    // structural clone and lose the prototype.
//    return document;
//  }
  if (EJSON._isCustomType(document)) {
    return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));
  }
  // It is not ordinarily possible to stick dollar-sign keys into mongo
  // so we don't bother checking for things that need escaping at this time.
  return undefined;
};

var replaceTypes = function (document, atomTransformer) {
  if (typeof document !== 'object' || document === null)
    return document;

  var replacedTopLevelAtom = atomTransformer(document);
  if (replacedTopLevelAtom !== undefined)
    return replacedTopLevelAtom;

  var ret = document;
  _.each(document, function (val, key) {
    var valReplaced = replaceTypes(val, atomTransformer);
    if (val !== valReplaced) {
      // Lazy clone. Shallow copy.
      if (ret === document)
        ret = _.clone(document);
      ret[key] = valReplaced;
    }
  });
  return ret;
};


RedisObserver = function (watcher, observer) {
  var self = this;
  self._watcher = watcher;
  var listener = function (key, message) {
    var methodName;
    if (message == 'hset' || message == 'set') {
      methodName = 'updated';
    } else if (message == 'hincrby'
               || message == 'incr'
               || message == 'incrby'
               || message == 'incrbyfloat'
               || message == 'decr'
               || message == 'decrby'
               || message == 'append') {
      methodName = 'updated';
    } else if (message == 'del') {
      methodName = 'removed';
    }

    if (!methodName) {
      Meteor._debug("RedisConnection::observe: Unknown message: " + message);
    } else {
      if (_.isFunction(observer[methodName])) {
        var value = { _id: key };
        observer[methodName](key, value);
      }
    }
//      addedAt: function (doc, before_index, before) {
//        log += 'a(' + doc.x + ',' + before_index + ',' + before + ')';
//      },
//      changedAt: function (new_doc, old_doc, at_index) {
//        log += 'c(' + new_doc.x + ',' + at_index + ',' + old_doc.x + ')';
//      },
//      movedTo: function (doc, old_index, new_index) {
//        log += 'm(' + doc.x + ',' + old_index + ',' + new_index + ')';
//      },
//      removedAt: function (doc, at_index) {
//        log += 'r(' + doc.x + ',' + at_index + ')';
//      }
  };
  self._listener = listener;
  watcher.addListener(listener);
};

RedisObserver.prototype.stop = function () {
  var self = this;
  self._watcher.removeListener(self._listener);
};

RedisConnection = function (url, options) {
  var self = this;
  options = options || {};
  self._connectCallbacks = [];
  self._observeMultiplexers = {};
  self._onFailoverHook = new Hook;

  var redisOptions = {}; // {db: {safe: true}, server: {}, replSet: {}};

  // Set autoReconnect to true, unless passed on the URL. Why someone
  // would want to set autoReconnect to false, I'm not really sure, but
  // keeping this for backwards compatibility for now.
//  if (!(/[\?&]auto_?[rR]econnect=/.test(url))) {
//    mongoOptions.server.auto_reconnect = true;
//  }

  // Disable the native parser by default, unless specifically enabled
  // in the mongo URL.
  // - The native driver can cause errors which normally would be
  //   thrown, caught, and handled into segfaults that take down the
  //   whole app.
  // - Binary modules don't yet work when you bundle and move the bundle
  //   to a different platform (aka deploy)
  // We should revisit this after binary npm module support lands.
//  if (!(/[\?&]native_?[pP]arser=/.test(url))) {
//    mongoOptions._client.native_parser = false;
//  }

  // XXX maybe we should have a better way of allowing users to configure the
  // underlying Mongo driver
//  if (_.has(options, 'poolSize')) {
//    // If we just set this for "server", replSet will override it. If we just
//    // set it for replSet, it will be ignored if we're not using a replSet.
//    mongoOptions.server.poolSize = options.poolSize;
//    mongoOptions.replSet.poolSize = options.poolSize;
//  }

  var client = self._client = new RedisClient(url, redisOptions);
  self._watcher = new RedisWatcher(url);

  // Note ==, not ===, so we accept '1' or 1
  var fixConfig = options.configureKeyspaceNotifications == '1';
  checkConfig(client, fixConfig);

//  MongoDB.connect(url, mongoOptions, Meteor.bindEnvironment(function(err, db) {
//    if (err)
//      throw err;
//    self._client = db;
//    // We keep track of the ReplSet's primary, so that we can trigger hooks when
//    // it changes.  The Node driver's joined callback seems to fire way too
//    // often, which is why we need to track it ourselves.
//    self._primary = null;
//    // First, figure out what the current primary is, if any.
//    if (self._client.serverConfig._state.master)
//      self._primary = self._client.serverConfig._state.master.name;
//    self._client.serverConfig.on(
//      'joined', Meteor.bindEnvironment(function (kind, doc) {
//        if (kind === 'primary') {
//          if (doc.primary !== self._primary) {
//            self._primary = doc.primary;
//            self._onFailoverHook.each(function (callback) {
//              callback();
//              return true;
//            });
//          }
//        } else if (doc.me === self._primary) {
//          // The thing we thought was primary is now something other than
//          // primary.  Forget that we thought it was primary.  (This means that
//          // if a server stops being primary and then starts being primary again
//          // without another server becoming primary in the middle, we'll
//          // correctly count it as a failover.)
//          self._primary = null;
//        }
//    }));
//
//    // drain queue of pending callbacks
//    _.each(self._connectCallbacks, function (c) {
//      c(_client);
//    });
//  }));

  // XXX: Authenticated connections?

  // XXX: Wait until 'ready' event?
  // drain queue of pending callbacks
  _.each(self._connectCallbacks, function (c) {
    c(client);
  });

  self._docFetcher = new DocFetcher(self);
  self._oplogHandle = null;

//  if (options.oplogUrl && !Package['disable-oplog']) {
//    var dbNameFuture = new Future;
//    self._withDb(function (db) {
//      dbNameFuture.return(db.databaseName);
//    });
//    self._oplogHandle = new OplogHandle(options.oplogUrl, dbNameFuture.wait());
//  }

  self._oplogHandle = new OplogHandle(self._client, self._watcher);
};

// Help the user, by verifying that notify-keyspace-events is set correctly
function checkConfig(client, fix) {
  var notifyConfig = Future.wrap(_.bind(client.getConfig, client))('notify-keyspace-events').wait();
  var config = '';
  var missing = '';
  if (_.isArray(notifyConfig) && notifyConfig.length >= 2) {
    config = notifyConfig[1];
  } else {
    throw new Error("Error from 'config get notify-keyspace-events'");
  }

  // K = keyspace events are being published
  if (config.indexOf('K') == -1) {
    missing += 'K';
  }

  // We need at least:
  //  $ string events
  //  h hash events
  //  g generic events (del)
  //  x expired events
  //  e evicted events
  //
  // "A" means "everything"
  if (config.indexOf('A') == -1) {
    _.each(['$', 'h', 'g', 'x', 'e'], function (key) {
      if (config.indexOf(key) == -1) {
        missing += key;
      }
    });
  }

  if (missing) {
    if (fix) {
      var newConfig = config + missing;
      Future.wrap(_.bind(client.setConfig, client))('notify-keyspace-events', newConfig).wait();

      // Sanity check!
      checkConfig(client, false);
    } else {
      throw new Error("You must configure notify-keyspace-events for Meteor (or launch with REDIS_CONFIGURE_KEYSPACE_NOTIFICATIONS=1).  Current config=" + config + " missing=" + missing);
    }
  }
};

RedisConnection.prototype.close = function() {
  var self = this;

  // XXX probably untested
  var oplogHandle = self._oplogHandle;
  self._oplogHandle = null;
  if (oplogHandle)
    oplogHandle.stop();

  // Use Future.wrap so that errors get thrown. This happens to
  // work even outside a fiber since the 'close' method is not
  // actually asynchronous.
  Future.wrap(_.bind(self._client.close, self._client))(true).wait();
};

RedisConnection.prototype._withDb = function (callback) {
  var self = this;
  if (self._client) {
    callback(self._client);
  } else {
    self._connectCallbacks.push(callback);
  }
};

// Returns the Mongo Collection object; may yield.
RedisConnection.prototype._getCollection = function (collectionName) {
  var self = this;

  var future = new Future;
  self._withDb(function (db) {
    db.collection(collectionName, future.resolver());
  });
  return future.wait();
};

RedisConnection.prototype._createCappedCollection = function (collectionName,
                                                              byteSize) {
  var self = this;
  var future = new Future();
  self._withDb(function (db) {
    db.createCollection(collectionName, {capped: true, size: byteSize},
                        future.resolver());
  });
  future.wait();
};

// This should be called synchronously with a write, to create a
// transaction on the current write fence, if any. After we can read
// the write, and after observers have been notified (or at least,
// after the observer notifiers have added themselves to the write
// fence), you should call 'committed()' on the object returned.
RedisConnection.prototype._maybeBeginWrite = function () {
  var self = this;
  var fence = DDPServer._CurrentWriteFence.get();
  if (fence)
    return fence.beginWrite();
  else
    return {committed: function () {}};
};

// Internal interface: adds a callback which is called when the Mongo primary
// changes. Returns a stop handle.
RedisConnection.prototype._onFailover = function (callback) {
  return this._onFailoverHook.register(callback);
};


//////////// Public API //////////

// The write methods block until the database has confirmed the write (it may
// not be replicated or stable on disk, but one server has confirmed it) if no
// callback is provided. If a callback is provided, then they call the callback
// when the write is confirmed. They return nothing on success, and raise an
// exception on failure.
//
// After making a write (with insert, update, remove), observers are
// notified asynchronously. If you want to receive a callback once all
// of the observer notifications have landed for your write, do the
// writes inside a write fence (set DDPServer._CurrentWriteFence to a new
// _WriteFence, and then set a callback on the write fence.)
//
// Since our execution environment is single-threaded, this is
// well-defined -- a write "has been made" if it's returned, and an
// observer "has been notified" if its callback has returned.

var writeCallback = function (write, refresh, callback) {
  return function (err, result) {
    if (! err) {
      // XXX We don't have to run this on error, right?
      refresh();
    }
    write.committed();
    if (callback)
      callback(err, result);
    else if (err)
      throw err;
  };
};

var bindEnvironmentForWrite = function (callback) {
  return Meteor.bindEnvironment(callback, "Mongo write");
};

RedisConnection.prototype._insert = function (collection_name, document,
                                              callback) {
  var self = this;

  var sendError = function (e) {
    if (callback)
      return callback(e);
    throw e;
  };

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e.expected = true;
    sendError(e);
    return;
  }

  if (!(LocalCollection._isPlainObject(document) &&
        !EJSON._isCustomType(document))) {
    sendError(new Error(
      "Only documents (plain objects) may be inserted into MongoDB"));
    return;
  }

  var write = self._maybeBeginWrite();
  var refresh = function () {
    Meteor.refresh({collection: collection_name, id: document._id });
  };
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));
  try {
    var collection = self._getCollection(collection_name);
    collection.insert(replaceTypes(document, replaceMeteorAtomWithRedis),
                      {safe: true}, callback);
  } catch (e) {
    write.committed();
    throw e;
  }
};

// Cause queries that may be affected by the selector to poll in this write
// fence.
RedisConnection.prototype._refresh = function (collectionName, selector) {
  var self = this;
  var refreshKey = {collection: collectionName};
  // If we know which documents we're removing, don't poll queries that are
  // specific to other documents. (Note that multiple notifications here should
  // not cause multiple polls, since all our listener is doing is enqueueing a
  // poll.)
  var specificIds = LocalCollection._idsMatchedBySelector(selector);
  if (specificIds) {
    _.each(specificIds, function (id) {
      Meteor.refresh(_.extend({id: id}, refreshKey));
    });
  } else {
    Meteor.refresh(refreshKey);
  }
};

RedisConnection.prototype._remove = function (collection_name, selector,
                                              callback) {
  var self = this;

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e.expected = true;
    if (callback)
      return callback(e);
    else
      throw e;
  }

  var write = self._maybeBeginWrite();
  var refresh = function () {
    self._refresh(collection_name, selector);
  };
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

  try {
    var collection = self._getCollection(collection_name);
    collection.remove(replaceTypes(selector, replaceMeteorAtomWithRedis),
                      {safe: true}, callback);
  } catch (e) {
    write.committed();
    throw e;
  }
};

RedisConnection.prototype._dropCollection = function (collectionName, cb) {
  var self = this;

  var write = self._maybeBeginWrite();
  var refresh = function () {
    Meteor.refresh({collection: collectionName, id: null,
                    dropCollection: true});
  };
  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

  try {
    var collection = self._getCollection(collectionName);
    collection.drop(cb);
  } catch (e) {
    write.committed();
    throw e;
  }
};

RedisConnection.prototype._update = function (collection_name, selector, mod,
                                              options, callback) {
  var self = this;

  if (! callback && options instanceof Function) {
    callback = options;
    options = null;
  }

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e.expected = true;
    if (callback)
      return callback(e);
    else
      throw e;
  }

  // explicit safety check. null and undefined can crash the mongo
  // driver. Although the node driver and minimongo do 'support'
  // non-object modifier in that they don't crash, they are not
  // meaningful operations and do not do anything. Defensively throw an
  // error here.
  if (!mod || typeof mod !== 'object')
    throw new Error("Invalid modifier. Modifier must be an object.");

  if (!options) options = {};

  var write = self._maybeBeginWrite();
  var refresh = function () {
    self._refresh(collection_name, selector);
  };
  callback = writeCallback(write, refresh, callback);
  try {
    var collection = self._getCollection(collection_name);
    var mongoOpts = {safe: true};
    // explictly enumerate options that minimongo supports
    if (options.upsert) mongoOpts.upsert = true;
    if (options.multi) mongoOpts.multi = true;

    var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithRedis);
    var mongoMod = replaceTypes(mod, replaceMeteorAtomWithRedis);

    var isModify = isModificationMod(mongoMod);
    var knownId = (isModify ? selector._id : mod._id);

    if (options.upsert && (! knownId) && options.insertedId) {
      // XXX In future we could do a real upsert for the mongo id generation
      // case, if the the node mongo driver gives us back the id of the upserted
      // doc (which our current version does not).
      simulateUpsertWithInsertedId(
        collection, mongoSelector, mongoMod,
        isModify, options,
        // This callback does not need to be bindEnvironment'ed because
        // simulateUpsertWithInsertedId() wraps it and then passes it through
        // bindEnvironmentForWrite.
        function (err, result) {
          // If we got here via a upsert() call, then options._returnObject will
          // be set and we should return the whole object. Otherwise, we should
          // just return the number of affected docs to match the mongo API.
          if (result && ! options._returnObject)
            callback(err, result.numberAffected);
          else
            callback(err, result);
        }
      );
    } else {
      collection.update(
        mongoSelector, mongoMod, mongoOpts,
        bindEnvironmentForWrite(function (err, result, extra) {
          if (! err) {
            if (result && options._returnObject) {
              result = { numberAffected: result };
              // If this was an upsert() call, and we ended up
              // inserting a new doc and we know its id, then
              // return that id as well.
              if (options.upsert && knownId &&
                  ! extra.updatedExisting)
                result.insertedId = knownId;
            }
          }
          callback(err, result);
        }));
    }
  } catch (e) {
    write.committed();
    throw e;
  }
};

var isModificationMod = function (mod) {
  for (var k in mod)
    if (k.substr(0, 1) === '$')
      return true;
  return false;
};

var NUM_OPTIMISTIC_TRIES = 3;

// exposed for testing
RedisConnection._isCannotChangeIdError = function (err) {
  // either of these checks should work, but just to be safe...
  return (err.code === 13596 ||
          err.err.indexOf("cannot change _id of a document") === 0);
};

var simulateUpsertWithInsertedId = function (collection, selector, mod,
                                             isModify, options, callback) {
  // STRATEGY:  First try doing a plain update.  If it affected 0 documents,
  // then without affecting the database, we know we should probably do an
  // insert.  We then do a *conditional* insert that will fail in the case
  // of a race condition.  This conditional insert is actually an
  // upsert-replace with an _id, which will never successfully update an
  // existing document.  If this upsert fails with an error saying it
  // couldn't change an existing _id, then we know an intervening write has
  // caused the query to match something.  We go back to step one and repeat.
  // Like all "optimistic write" schemes, we rely on the fact that it's
  // unlikely our writes will continue to be interfered with under normal
  // circumstances (though sufficiently heavy contention with writers
  // disagreeing on the existence of an object will cause writes to fail
  // in theory).

  var newDoc;
  // Run this code up front so that it fails fast if someone uses
  // a Mongo update operator we don't support.
  if (isModify) {
    // We've already run replaceTypes/replaceMeteorAtomWithRedis on
    // selector and mod.  We assume it doesn't matter, as far as
    // the behavior of modifiers is concerned, whether `_modify`
    // is run on EJSON or on mongo-converted EJSON.
    var selectorDoc = LocalCollection._removeDollarOperators(selector);
    LocalCollection._modify(selectorDoc, mod, {isInsert: true});
    newDoc = selectorDoc;
  } else {
    newDoc = mod;
  }

  var insertedId = options.insertedId; // must exist
  var mongoOptsForUpdate = {
    safe: true,
    multi: options.multi
  };
  var mongoOptsForInsert = {
    safe: true,
    upsert: true
  };

  var tries = NUM_OPTIMISTIC_TRIES;

  var doUpdate = function () {
    tries--;
    if (! tries) {
      callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));
    } else {
      collection.update(selector, mod, mongoOptsForUpdate,
                        bindEnvironmentForWrite(function (err, result) {
                          if (err)
                            callback(err);
                          else if (result)
                            callback(null, {
                              numberAffected: result
                            });
                          else
                            doConditionalInsert();
                        }));
    }
  };

  var doConditionalInsert = function () {
    var replacementWithId = _.extend(
      replaceTypes({_id: insertedId}, replaceMeteorAtomWithRedis),
      newDoc);
    collection.update(selector, replacementWithId, mongoOptsForInsert,
                      bindEnvironmentForWrite(function (err, result) {
                        if (err) {
                          // figure out if this is a
                          // "cannot change _id of document" error, and
                          // if so, try doUpdate() again, up to 3 times.
                          if (RedisConnection._isCannotChangeIdError(err)) {
                            doUpdate();
                          } else {
                            callback(err);
                          }
                        } else {
                          callback(null, {
                            numberAffected: result,
                            insertedId: insertedId
                          });
                        }
                      }));
  };

  doUpdate();
};

_.each(["insert", "update", "remove", "dropCollection"], function (method) {
  RedisConnection.prototype[method] = function (/* arguments */) {
    throw new Error("not part of redis api");
  };
});

_.each(REDIS_COMMANDS_LOCAL, function (method) {
  RedisConnection.prototype[method] = function (/* arguments */) {
    var self = this;
    var wrapAsync = Meteor.wrapAsync || Meteor._wrapAsync;
    return wrapAsync(self._client[method]).apply(self._client, arguments);
  };
});

_.each(["set", "setex", "append", "del",
        "incr", "incrby", "incrbyfloat", "decr", "decrby",
        "flushall"].concat(REDIS_COMMANDS_HASH), function (method) {
  if (_.has(REDIS_COMMANDS_LOCAL, method)) {
    return;
  }

  RedisConnection.prototype[method] = function (/* arguments */) {
    var self = this;
    var wrapAsync = Meteor.wrapAsync || Meteor._wrapAsync;
    return wrapAsync(self["_" + method]).apply(self, arguments);
  };

  RedisConnection.prototype["_" + method] = function (key /*, arguments */) {
    var self = this;

    var args = _.toArray(arguments);

    var callback = args.pop();

    var sendError = function (e) {
      if (callback)
        return callback(e);
      throw e;
    };

    var collection_name = 'redis';

    var write = self._maybeBeginWrite();
    var refresh = function () {
      Meteor.refresh({ collection: collection_name, id: key });
    };
    callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));
    try {
      args.push(callback);
      //var collection = self._getCollection(collection_name);
      var self = this;

      var future = new Future;
      self._withDb(function (db) {
        future.return(db);
      });
      var db = future.wait();
      db[method].apply(db, args);
    } catch (e) {
      write.committed();
      throw e;
    }
  };
});

RedisConnection.prototype.matching = function (collectionName, pattern) {
  var self = this;

  return new Cursor(
    self, new CursorDescription(collectionName, pattern));
};

RedisConnection.prototype._observe = function (observer) {
  var self = this;
  return new RedisObserver(self._watcher, observer);
};


// We'll actually design an index API later. For now, we just pass through to
// Mongo's, but make it synchronous.
RedisConnection.prototype._ensureIndex = function (collectionName, index,
                                                   options) {
  var self = this;
  options = _.extend({safe: true}, options);

  // We expect this function to be called at startup, not from within a method,
  // so we don't interact with the write fence.
  var collection = self._getCollection(collectionName);
  var future = new Future;
  var indexName = collection.ensureIndex(index, options, future.resolver());
  future.wait();
};
RedisConnection.prototype._dropIndex = function (collectionName, index) {
  var self = this;

  // This function is only used by test code, not within a method, so we don't
  // interact with the write fence.
  var collection = self._getCollection(collectionName);
  var future = new Future;
  var indexName = collection.dropIndex(index, future.resolver());
  future.wait();
};

// CURSORS

// There are several classes which relate to cursors:
//
// CursorDescription represents the arguments used to construct a cursor:
// collectionName, selector, and (find) options.  Because it is used as a key
// for cursor de-dup, everything in it should either be JSON-stringifiable or
// not affect observeChanges output (eg, options.transform functions are not
// stringifiable but do not affect observeChanges).
//
// SynchronousCursor is a wrapper around a MongoDB cursor
// which includes fully-synchronous versions of forEach, etc.
//
// Cursor is the cursor object returned from find(), which implements the
// documented Meteor.RedisCollection cursor API.  It wraps a CursorDescription and a
// SynchronousCursor (lazily: it doesn't contact Mongo until you call a method
// like fetch or forEach on it).
//
// ObserveHandle is the "observe handle" returned from observeChanges. It has a
// reference to an ObserveMultiplexer.
//
// ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a
// single observe driver.
//
// There is one "observe driver" which drives ObserveMultiplexers:
//   - KeyspaceNotificationObserveDriver uses redis keyspace notifications to
//     directly observe database changes.
// Implementations follow the normal driver interface: when you create them,
// they start sending observeChanges callbacks (and a ready() invocation) to
// their ObserveMultiplexer, and you stop them by calling their stop() method.

CursorDescription = function (collectionName, pattern) {
  var self = this;
  self.collectionName = collectionName;
  self.pattern = pattern;
  self.options = {};
};

Cursor = function (connection, cursorDescription) {
  var self = this;

  self._connection = connection;
  self._cursorDescription = cursorDescription;
  self._synchronousCursor = null;
};

_.each(['forEach', 'map', 'rewind', 'fetch', 'count'], function (method) {
  Cursor.prototype[method] = function () {
    var self = this;

    // You can only observe a tailable cursor.
    if (self._cursorDescription.options.tailable)
      throw new Error("Cannot call " + method + " on a tailable cursor");

    if (!self._synchronousCursor) {
      self._synchronousCursor = self._connection._createSynchronousCursor(
        self._cursorDescription, {
          // Make sure that the "self" argument to forEach/map callbacks is the
          // Cursor, not the SynchronousCursor.
          selfForIteration: self,
          useTransform: true
        });
    }

    return self._synchronousCursor[method].apply(
      self._synchronousCursor, arguments);
  };
});

Cursor.prototype.getTransform = function () {
  return this._cursorDescription.options.transform;
};

// When you call Meteor.publish() with a function that returns a Cursor, we need
// to transmute it into the equivalent subscription.  This is the function that
// does that.

Cursor.prototype._publishCursor = function (sub) {
  var self = this;
  var collection = "redis"; // XXX don't hard-code this
  return Meteor.RedisCollection._publishCursor(self, sub, collection);
};

// Used to guarantee that publish functions return at most one cursor per
// collection. Private, because we might later have cursors that include
// documents from multiple collections somehow.
Cursor.prototype._getCollectionName = function () {
  var self = this;
  return self._cursorDescription.collectionName;
};


Cursor.prototype.observe = function (callbacks) {
  var self = this;
  //return self._connection._observe(callbacks);
  var pattern = self._cursorDescription.pattern;
  return self._connection._observe(self._cursorDescription, callbacks);
//  return LocalCollection._observeFromObserveChanges(self, callbacks);
};

Cursor.prototype.observeChanges = function (callbacks) {
  var self = this;
  //var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks);
//  return self._connection._observeChanges(
//    self._cursorDescription, ordered, callbacks);
  try {
    return self._connection._observeChanges(self._cursorDescription, callbacks);
  } catch (e) {
    Meteor._debug("Error in _observeChanges", e.stack);
    throw e;
  }
};

RedisConnection.prototype._createSynchronousCursor = function(
    cursorDescription, options) {
  var self = this;

  var pattern = cursorDescription.pattern;
//  options = _.pick(options || {}, 'selfForIteration', 'useTransform');

//  var collection = self._getCollection(cursorDescription.collectionName);
//  var cursorOptions = cursorDescription.options;
//  var mongoOptions = {
//    sort: cursorOptions.sort,
//    limit: cursorOptions.limit,
//    skip: cursorOptions.skip
//  };

//  // Do we want a tailable cursor (which only works on capped collections)?
//  if (cursorOptions.tailable) {
//    // We want a tailable cursor...
//    mongoOptions.tailable = true;
//    // ... and for the server to wait a bit if any getMore has no data (rather
//    // than making us put the relevant sleeps in the client)...
//    mongoOptions.awaitdata = true;
//    // ... and to keep querying the server indefinitely rather than just 5 times
//    // if there's no more data.
//    mongoOptions.numberOfRetries = -1;
//    // And if this is on the oplog collection and the cursor specifies a 'ts',
//    // then set the undocumented oplog replay flag, which does a special scan to
//    // find the first document (instead of creating an index on ts). This is a
//    // very hard-coded Mongo flag which only works on the oplog collection and
//    // only works with the ts field.
//    if (cursorDescription.collectionName === OPLOG_COLLECTION &&
//        cursorDescription.selector.ts) {
//      mongoOptions.oplogReplay = true;
//    }
//  }


//  var dbCursor = collection.find(
//    replaceTypes(cursorDescription.selector, replaceMeteorAtomWithRedis),
//    cursorOptions.fields, mongoOptions);
//
//  return new SynchronousCursor(dbCursor, cursorDescription, options);


  var future = new Future;
  self._withDb(function (db) {
    db.matching(pattern, future.resolver());
  });
  var entries = future.wait();

  return new SynchronousCursor(entries, cursorDescription, options);

};

var SynchronousCursor = function (entries, cursorDescription, options) {
  var self = this;
//  options = _.pick(options || {}, 'selfForIteration', 'useTransform');

  self._entries = entries;
  self._pos = -1;
  self._cursorDescription = cursorDescription;
  // The "self" argument passed to forEach/map callbacks. If we're wrapped
  // inside a user-visible Cursor, we want to provide the outer cursor!
//  self._selfForIteration = options.selfForIteration || self;
//  if (options.useTransform && cursorDescription.options.transform) {
//    self._transform = LocalCollection.wrapTransform(
//      cursorDescription.options.transform);
//  } else {
//    self._transform = null;
//  }

  // Need to specify that the callback is the first argument to nextObject,
  // since otherwise when we try to call it with no args the driver will
  // interpret "undefined" first arg as an options hash and crash.
//  self._synchronousNextObject = Future.wrap(
//    dbCursor.nextObject.bind(dbCursor), 0);
//  self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));
  self._visitedIds = new IdMap; // LocalCollection._IdMap;
};

_.extend(SynchronousCursor.prototype, {
//  _synchronousNextObject: function () {
//
//  },
  _nextObject: function () {
    var self = this;

    while (true) {
      //var doc = self._synchronousNextObject().wait();
      var doc;
      if ((self._pos + 1) < self._entries.length) {
        self._pos++;
        doc = self._entries[self._pos];
      }

      if (!doc) return null;
      doc = replaceTypes(doc, replaceRedisAtomWithMeteor);

      if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {
        // Did Mongo give us duplicate documents in the same cursor? If so,
        // ignore this one. (Do this before the transform, since transform might
        // return some unrelated value.) We don't do this for tailable cursors,
        // because we want to maintain O(1) memory usage. And if there isn't _id
        // for some reason (maybe it's the oplog), then we don't do this either.
        // (Be careful to do this for falsey but existing _id, though.)
        if (self._visitedIds.has(doc._id)) continue;
        self._visitedIds.set(doc._id, true);
      }

      if (self._transform)
        doc = self._transform(doc);

      return doc;
    }
  },

  forEach: function (callback, thisArg) {
    var self = this;

    // We implement the loop ourself instead of using self._dbCursor.each,
    // because "each" will call its callback outside of a fiber which makes it
    // much more complex to make this function synchronous.
    var index = 0;
    while (true) {
      var doc = self._nextObject();
      if (!doc) return;
      callback.call(thisArg, doc, index++, self._selfForIteration);
    }
  },

  // XXX Allow overlapping callback executions if callback yields.
  map: function (callback, thisArg) {
    var self = this;
    var res = [];
    self.forEach(function (doc, index) {
      res.push(callback.call(thisArg, doc, index, self._selfForIteration));
    });
    return res;
  },

  rewind: function () {
    var self = this;

    // known to be synchronous
    self._dbCursor.rewind();

    self._visitedIds = new LocalCollection._IdMap;
  },

  // Mostly usable for tailable cursors.
  close: function () {
    var self = this;

    self._dbCursor.close();
  },

  fetch: function () {
    var self = this;
    return self.map(_.identity);
  },

  count: function () {
    var self = this;
    return self._entries.length;
//    return self._synchronousCount().wait();
  },

  // This method is NOT wrapped in Cursor.
  getRawObjects: function (ordered) {
    var self = this;
    if (ordered) {
      return self.fetch();
    } else {
      var results = new LocalCollection._IdMap;
      self.forEach(function (doc) {
        results.set(doc._id, doc);
      });
      return results;
    }
  }
});

RedisConnection.prototype._observeChanges = function (cursorDescription, callbacks) {
  var self = this;

//  if (cursorDescription.options.tailable) {
//    return self._observeChangesTailable(cursorDescription, ordered, callbacks);
//  }

//  // You may not filter out _id when observing changes, because the id is a core
//  // part of the observeChanges API.
//  if (cursorDescription.options.fields &&
//      (cursorDescription.options.fields._id === 0 ||
//       cursorDescription.options.fields._id === false)) {
//    throw Error("You may not observe a cursor with {fields: {_id: 0}}");
//  }

  var observeKey = JSON.stringify(
    _.extend({ /*ordered: ordered */}, cursorDescription));

  var multiplexer, observeDriver;
  var firstHandle = false;

  // Find a matching ObserveMultiplexer, or create a new one. This next block is
  // guaranteed to not yield (and it doesn't call anything that can observe a
  // new query), so no other calls to this function can interleave with it.
  Meteor._noYieldsAllowed(function () {
    if (_.has(self._observeMultiplexers, observeKey)) {
      multiplexer = self._observeMultiplexers[observeKey];
    } else {
      firstHandle = true;
      // Create a new ObserveMultiplexer.
      multiplexer = new ObserveMultiplexer({
        //ordered: ordered,
        onStop: function () {
          observeDriver.stop();
          delete self._observeMultiplexers[observeKey];
        }
      });
      self._observeMultiplexers[observeKey] = multiplexer;
    }
  });

  var observeHandle = new ObserveHandle(multiplexer, callbacks);

  if (firstHandle) {
    var driverClass = KeyspaceNotificationObserveDriver;
    observeDriver = new driverClass({
      cursorDescription: cursorDescription,
      mongoHandle: self,
      multiplexer: multiplexer,
      _testOnlyPollCallback: callbacks._testOnlyPollCallback
    });

    // This field is only set for use in tests.
    multiplexer._observeDriver = observeDriver;
  }

  // Blocks until the initial adds have been sent.
  multiplexer.addHandleAndSendInitialAdds(observeHandle);

  return observeHandle;
};

// Listen for the invalidation messages that will trigger us to poll the
// database for changes. If this selector specifies specific IDs, specify them
// here, so that updates to different specific IDs don't cause us to poll.
// listenCallback is the same kind of (notification, complete) callback passed
// to InvalidationCrossbar.listen.

listenAll = function (cursorDescription, listenCallback) {
  var listeners = [];
  forEachTrigger(cursorDescription, function (trigger) {
    listeners.push(DDPServer._InvalidationCrossbar.listen(
      trigger, listenCallback));
  });

  return {
    stop: function () {
      _.each(listeners, function (listener) {
        listener.stop();
      });
    }
  };
};

forEachTrigger = function (cursorDescription, triggerCallback) {
//  var key = {collection: cursorDescription.collectionName};
  var key = { collection: 'redis' };
//  var specificIds = LocalCollection._idsMatchedBySelector(
//    cursorDescription.selector);
//  if (specificIds) {
//    _.each(specificIds, function (id) {
//      triggerCallback(_.extend({id: id}, key));
//    });
//    triggerCallback(_.extend({dropCollection: true, id: null}, key));
//  } else {
    triggerCallback(key);
//  }
};

// observeChanges for tailable cursors on capped collections.
//
// Some differences from normal cursors:
//   - Will never produce anything other than 'added' or 'addedBefore'. If you
//     do update a document that has already been produced, this will not notice
//     it.
//   - If you disconnect and reconnect from Mongo, it will essentially restart
//     the query, which will lead to duplicate results. This is pretty bad,
//     but if you include a field called 'ts' which is inserted as
//     new RedisInternals.MongoTimestamp(0, 0) (which is initialized to the
//     current Mongo-style timestamp), we'll be able to find the place to
//     restart properly. (This field is specifically understood by Mongo with an
//     optimization which allows it to find the right place to start without
//     an index on ts. It's how the oplog works.)
//   - No callbacks are triggered synchronously with the call (there's no
//     differentiation between "initial data" and "later changes"; everything
//     that matches the query gets sent asynchronously).
//   - De-duplication is not implemented.
//   - Does not yet interact with the write fence. Probably, this should work by
//     ignoring removes (which don't work on capped collections) and updates
//     (which don't affect tailable cursors), and just keeping track of the ID
//     of the inserted object, and closing the write fence once you get to that
//     ID (or timestamp?).  This doesn't work well if the document doesn't match
//     the query, though.  On the other hand, the write fence can close
//     immediately if it does not match the query. So if we trust minimongo
//     enough to accurately evaluate the query against the write fence, we
//     should be able to do this...  Of course, minimongo doesn't even support
//     Mongo Timestamps yet.
RedisConnection.prototype._observeChangesTailable = function (
    cursorDescription, ordered, callbacks) {
  var self = this;

  // Tailable cursors only ever call added/addedBefore callbacks, so it's an
  // error if you didn't provide them.
  if ((ordered && !callbacks.addedBefore) ||
      (!ordered && !callbacks.added)) {
    throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered")
                    + " tailable cursor without a "
                    + (ordered ? "addedBefore" : "added") + " callback");
  }

  return self.tail(cursorDescription, function (doc) {
    var id = doc._id;
    delete doc._id;
    // The ts is an implementation detail. Hide it.
    delete doc.ts;
    if (ordered) {
      callbacks.addedBefore(id, doc, null);
    } else {
      callbacks.added(id, doc);
    }
  });
};

// XXX We probably need to find a better way to expose this. Right now
// it's only used by tests, but in fact you need it in normal
// operation to interact with capped collections (eg, Galaxy uses it).
//RedisInternals.MongoTimestamp = MongoDB.Timestamp;

RedisInternals.Connection = RedisConnection;
