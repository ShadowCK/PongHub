// Setup socket IO
const http = require('http');
const { Server } = require('socket.io');
const game = require('./game');
const packets = require('./packets');

const SESSION_RELOAD_INTERVAL = 3 * 1000;

/** @type {import('socket.io').Server} */
let io;

/**
 * @param {import('socket.io').Socket} socket
 */
const initSocketEvents = (socket) => {
  // Note: To access/modify session data, manually reload session by calling
  // socket.request.session.reload() to ensure the session object has the latest data
  // as socket.io does not do this for us. (only automatically updated for http requests)
  socket.on('disconnect', () => {
    console.log('A user disconnected');
    const { session } = socket.request;
    session.reload((err) => {
      console.log('Cleaning socket.io-related session data');
      if (err) {
        console.log('Session alreay destroyed, probably because user logged out.');
      } else {
        session.isConnectedToGame = false;
        session.save();
      }
    });
    game.onPlayerLeave(socket);
  });

  socket.on('playerMovement', (packet) => {
    game.onPlayerMovementPacket(
      new packets.PlayerMovementPacket({ playerId: socket.id, ...packet }),
    );
  });

  socket.on('chatMessage', (packet) => {
    const { session } = socket.request;
    const { team } = game.players[socket.id];
    io.emit(
      'chatMessage',
      new packets.PlayerChatPacket({
        playerId: socket.id,
        username: session.account.username,
        team,
        ...packet,
      }),
    );
    // TODO: Add a chat history to the game state and call game.onPlayerChatPacket to update it.
  });

  const gameData = game.getGameData();
  // Initial game update to the client
  socket.emit('gameUpdate', gameData);

  // ...Other code...
};

const socketSetup = (app, sessionMiddleware, serverStartTime) => {
  const server = http.createServer(app);
  io = new Server(server);
  // This grants socket.io access to the session data
  io.engine.use(sessionMiddleware);

  io.on('connection', async (socket) => {
    console.log('A user tries to connect');
    const { session } = socket.request;

    // I tried to use a socket.io middleware to disconnect but then the client
    // won't receive the 'rejected' event
    if (!session.account) {
      console.log("Rejected the user because they're not logged in");
      socket.emit('rejected', "You're not logged in");
      socket.disconnect();
      return;
    }
    if (!session.serverStartTime || session.serverStartTime !== serverStartTime) {
      console.log("Server restarted, resetting session's isConnectedToGame");
      session.serverStartTime = serverStartTime;
      session.isConnectedToGame = false;
    }
    if (session.isConnectedToGame === true) {
      console.log("Rejected the user because they're already connected to the game");
      socket.emit('rejected', "You're already connected to the game");
      socket.disconnect();
      return;
    }

    session.isConnectedToGame = true;
    session.save();

    console.log('The user connected');
    console.log(session);

    // Regularly check if the session is still valid. If not, disconnect the user.
    const timer = setInterval(() => {
      session.reload((err) => {
        if (err) {
          console.log('session does not exist anymore, forcing the user to reconnect');
          // Similar to socket.disconnect(), but this allows the client to reconnect
          socket.conn.close();
        }
      });
    }, SESSION_RELOAD_INTERVAL);
    socket.on('disconnect', () => {
      clearInterval(timer);
    });

    game.onPlayerJoin(socket);
    initSocketEvents(socket);
  });

  setInterval(() => {
    game.gameLoop();
    // TODO: This is super dirty and laggy because it spams the client and abuses network
    // But it works for now
    io.emit('gameUpdate', game.getGameData());
  }, 1000 / 60);
  return server;
};

module.exports = socketSetup;
