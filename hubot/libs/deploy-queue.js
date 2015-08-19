/**
 * Description:
 *   Manages a Trello-backed deployment queue.  Specifically, rather
 *   than forcing Khan devs to manually muck around with the HipChat
 *   topic in the 1 and 0s deploy room, this instead backs the queue
 *   with the Trello board https://trello.com/b/wE7cxYDT.  Users can
 *   add themselves to the queue and manipulate the queue, either from
 *   this module or directly on the Trello board. Each card represents
 *   a single user who is waiting in line.
 *
 *   Other modules (e.g. sun.js at the moment) can register themselves
 *   via callbacks to this module to be aware when the queue changes.
 *   This module does not itself do any deploys.
 *
 * Dependencies:
 *   Q, node-trello
 *
 * Configuration:
 *   None
 *
 * Author:
 *   benjaminpollack, mikelee
 */

import Trello from "node-trello";
import Q from "q";
const queueColumn = "In Line";

const runningColumn = "Deploying";
const doneColumn = "Completed";

// main Queue singleton
export default class Queue {
  constructor(robot) {
    // This list of functions to be called back when the subject changes
    this._setSubjectCallbacks = [];
    // The list of functions to be called when we need to publish a
    // random message
    this._notifierCallbacks = [];

    // Trello list IDs for the three lists we care about
    this._columnIds = {
      queueId: null,
      runningId: null,
      doneId: null
    };

    // Singleton for holding Trello auth creds
    this._trello = null;

    // How long, in milliseconds, to wait for someone to begin a deploy before
    // giving up on them.
    this._notifyPatience = 5 * 60 * 1000;

    // How often, in milliseconds, to query Trello for changes
    this._trelloQueryRate = 3 * 1000;

    // Current subject.  Used to avoid spurious subject changes.
    this._subject = "";

    this.startMonitoring();
  }

  // Registers a subject change callback. The callback should take a single
  // parameter, which is the new subject.
  addSubjectCallback(updater) {
    this._setSubjectCallbacks.push(updater);
  }

  // Adds a notification callback. To allow this module to work equally
  // well with HipChat and Slack, we expect that a relevant bot system
  // registers a preferred mechanism for sending notifications.  The callback
  // is expected to have the form cb(user, message, severity), where severity
  // is one of this.severity's states.
  addNotificationCallback(notifier) {
    this._notifierCallbacks.push(notifier);
  }

  // Constants to be used with severities
  static get severity() {
    return {
      HIGH: "high",
      MEDIUM: "medium",
      LOW: "low",
    };
  }

  // Marks a deploy as in progress and moves the user's card to the running
  // column.  The user passed in should be a string that reflects a card that
  // already exists in the queue column on the Trello board, but if none
  // exists, one will be created.
  startDeploy(user) {
    this.getDeploymentState()
      .then(state => {
        let cardId = this._findCardForOwner(state.queue, user);
        if (cardId !== null) {
          _commentOnCard(this._trello, cardId, "Beginning deploy!").done();
          _moveCard(this._trello, cardId, this._columnIds.runningId).done();
        } else {
          // no card was found, so make one
          _addCard(this._trello, this._columnIds.runningId, user).done();
        }
      });
  }

  // Mark the given user's deploy as successful.  If the user is not marked
  // as running, then this is a no-op.
  markSuccess(user) {
    this.getDeploymentState()
      .then(state => {
        let cardId = this._findCardForOwner(state.running, user);
        if (cardId !== null) {
          _commentOnCard(this._trello, cardId, "Deploy succeeded!").done();
          _moveCard(this._trello, cardId, this._columnIds.doneId).done();
        }
      });
  }

  // Mark the given user's deploy as unsuccessful.  If the user is not marked
  // as running, then this is a no-op.
  markFailure(user) {
    this.getDeploymentState()
      .then(state => {
        var cardId = this._findCardForOwner(state.running, user);
        if (cardId !== null) {
          _commentOnCard(this.trello, cardId, "Deploy failed!").done();
          _moveCard(this.trello, cardId, this._columnIds.queueId, "top").done();
        }
      });
  }

  // Add a given user to the queue by creating a new card with their name
  // in the "In Line" column of the Trello board
  enqueue(user) {
    _addCard(this.trello, this._columnIds.queueId, user);
  }

  // Return a promise that returns an object representing the deployemtn
  // state.  The object has two lists, called "queue" and "running", that
  // contain an ordered list of who's in the queue and who's running.
  // Theoretically, only one should be marked running at a time.
  getDeploymentState() {
    return _getCards(this.trello, this._columnIds.queueId).then(queueCards => {
      return _getCards(this.trello, this._columnIds.runningId).then(runningCards => {
        return {queue: queueCards, running: runningCards};
      });
    });
  }

  // Internal use. Causes deploy-queue to start monitoring the Trello
  // board for changes, and to take appropriate actions (e.g., notifying
  // a user they're up).
  startMonitoring() {
    this.trello = new Trello(process.env.TRELLO_KEY, process.env.TRELLO_TOKEN);
    this._initializeListIds().then(() => {
      setInterval(this._monitor, this._trelloQueryRate);
    }).done();
  }

  // Stores a mapping from the desired list names to their
  // internal Trello IDs so we don't have to look them up constantly.
  _initializeListIds() {
    return _getLists(this.trello, process.env.TRELLO_BOARD_ID)
      .then(lists => {
        return _getListIds(lists, [queueColumn, runningColumn, doneColumn]);
      }).then(ids => {
        this._columnIds.queueId = ids[0];
        this._columnIds.runningId = ids[1];
        this._columnIds.doneId = ids[2];
      });
  }

  // Steps the state machine based on the Trello baord state,
  // taking whatever action is appropriate based on the time and board state.
  // This function is idempotent, and should only send notifications or alter
  // the state if it's necessary.
  _monitor() {
    this.getDeploymentState()
      .then(state => {
        this._handleUserNotifications(state);
        this._updateSubject(state);
      }).done();
  }

  // Notifies users that they're up or that they're losing their
  // spot in the queue.
  _handleUserNotifications(state) {
    if (state.running.length === 0 && state.queue.length > 0) {
      let card = state.queue[0];
      _getComments(this.trello, card.id)
        .then(comments => {
          let lastComment = comments && comments[0] ? comments[0].data.text : "";
          let lastUpdated = Date.parse(card.dateLastActivity);
          if (lastComment.indexOf("Notified ") === 0 &&
              (Date.now() - lastUpdated) > this._notifyPatience) {
            if (state.queue.length === 1) {
              this._notify(card.name, "hey, you know you're clear to deploy, right?", Queue.severity.HIGH);
              _commentOnCard(this.trello, card.id, "Notified " + card.name + " again...");
            } else {
              this._notify(card.name, "sorry; there are others in the queue, so sending you to the back", Queue.severity.HIGH);
              _commentOnCard(this.trello, card.id, "Gave up on " + card.name);
              this._rotateDeploymentQueue(state);
            }
          } else {
            if (lastComment.indexOf("Notified ") !== 0) {
              this._notify(card.name, "you're up!", Queue.severity.LOW);
              _commentOnCard(this.trello, card.id, "Notified " + card.name + " they're up");
            }
          }
        });
    }
  }

  // Rotates the deployment queue, sending whoever's at the front
  // to the back. Should only be called by handleUserNotifications.
  _rotateDeploymentQueue(state) {
    _moveCard(this.trello, state.queue[0].id, this._columnIds.queueId, 'bottom').done();
  }

  // Sends a message to the chat client. To enable future
  // flexibility, this function doesn't directly send anything; instead, it
  // relies on at least one module having registered a callback.
  _notify(user, message, severity) {
    for (let callback of this._notifierCallbacks) {
      callback(user, message, severity);
    }
  }

  // Updates the subject to reflect the current state of the
  // deployment queue.
  _updateSubject(state) {
    const prefix = (state.running.length === 1 ? state.running[0].name : " -- ") + " | ";
    const suffix = "[" + state.queue.map(card => card.name).join(", ") + "]";
    this.subject = prefix + suffix + " (alter the queue manually at https://trello.com/b/wE7cxYDT)";
  }

  // Sets the subject to an arbitrary string. Note that this relies
  // on at least one subject change handler having been registered by
  // addSubjectCallback.
  set subject(subject) {
    if (this._subject === subject) {
      return;
    }
    this._subject = subject;
    for (let callback of this._setSubjectCallbacks) {
      callback(subject);
    }
  }

  get subject() {
    return this._subject;
  }

  // Finds the first card that includes a given user. A card is considered
  // to have the format name[+name[+name[...]]]. An array will always be
  // returned, even if only one user is listed.
  _findCardForOwner(list, user) {
    var cardId = null;
    for (let card of list) {
      for (let userName of card.name.split("+")) {
        // Shut up arc's linter
        if (userName === user && cardId !== null) {
          return card.id;
        }
      }
    }
    return null;
  }
}


// Returns a Promise to return a list of all cards in the given list.
function _getCards(trello, listId) {
  return Q.ninvoke(trello, "get", "/1/lists/" + listId, {cards: "open"})
    .then(data => data.cards);
}

// Returns a Promise to return all comments on a given card.
function _getComments(trello, cardId) {
  return Q.ninvoke(trello, "get", "/1/cards/" + cardId + "/actions", {filter: "commentCard"});
}

// Asynchronously adds a card with the given title.
function _addCard(trello, listId, title) {
  return Q.ninvoke(trello, "post", "/1/lists/" + listId + "/cards", {name: title});
}


// Returns a promise with the result of trying to move a card to the given
// list.  Position is optional; if not provided, the card is added to the top
// (the Trello default).
function _moveCard(trello, cardId, listId, position) {
  var args = {idList: listId};
  if (position !== undefined) {
    args['pos'] = position;
  }
  return Q.ninvoke(trello, "put", "/1/cards/" + cardId, args);
}

// Returns a promise with the result of adding the given comment
// to the card.
function _commentOnCard(trello, cardId, comment) {
  return Q.ninvoke(trello, "post", "/1/cards/" + cardId + "/actions/comments",
    {text: comment});
}

// Returns a promise to return a list of all lists on the given
// board.
function _getLists(trello, board) {
  return Q.ninvoke(trello, "get", "/1/boards/" + board, {
    lists: "open",
    list_fields: "name"
  })
    .then(data => data.lists);
}

// Given a collection of Trello lists (e.g. from the _getLists call,
// although any JSON from any Trello API call that returns lists (e.g. the
// board detail request) will work), returns the Trello list IDs for the Trello
// boards specified in desiredNames, in that order. For example, if you passed
// in a lists collection that included a list named "Bob" with ID 123 and one
// named "Susan" with ID 456, then _getListIds(lists, ["Susan", "Bob"]) would
// return ["456", "123"]. This is written in this manner to allow for easy
// destructuring binds...which the Node version on toby can't currently do. But
// one day.
function _getListIds(lists, desiredNames) {
  var ids = [];
  var idMap = {};
  for (let list of lists) {
    idMap[list.name] = list.id;
  }
  for (let userName of desiredNames) {
    ids.push(idMap[userName]);
  }
  return ids;
}
