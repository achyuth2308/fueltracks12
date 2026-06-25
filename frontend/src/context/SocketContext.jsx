import React, { createContext, useState, useEffect, useContext } from 'react';
import { io } from 'socket.io-client';
import { AuthContext } from './AuthContext';

export const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user, isAuthenticated } = useContext(AuthContext) || {};
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      const token = localStorage.getItem('token');
      const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

      // Phase 6 of SCALING_ROADMAP.md: jittered reconnect config.
      // Without jitter, every browser reconnects at the same instant
      // after a backend restart, creating a thundering herd that
      // saturates the single Node.js process's connection handler.
      const socketInstance = io(socketUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
        // randomizationFactor 0.5 → actual delay is base * (1 ± 0.5).
        randomizationFactor: 0.5,
        timeout: 10000,
      });

      socketInstance.on('connect', () => {
        console.log('[SOCKET] Connected to WebSocket server');
        setConnected(true);
      });

      socketInstance.on('disconnect', () => {
        console.log('[SOCKET] Disconnected from WebSocket server');
        setConnected(false);
      });

      socketInstance.on('connect_error', (error) => {
        console.error('[SOCKET] Connection error:', error);
        setConnected(false);
      });

      setSocket(socketInstance);

      return () => {
        console.log('[SOCKET] Cleaning up WebSocket connection');
        socketInstance.disconnect();
        setSocket(null);
        setConnected(false);
      };
    } else {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setConnected(false);
      }
    }
  }, [isAuthenticated]);

  const joinVehicleRoom = (vehicleId) => {
    if (socket && connected) {
      console.log(`[SOCKET] Requesting join for vehicle:${vehicleId}`);
      socket.emit('join:vehicle', { vehicleId });
    }
  };

  const leaveVehicleRoom = (vehicleId) => {
    if (socket && connected) {
      console.log(`[SOCKET] Requesting leave for vehicle:${vehicleId}`);
      socket.emit('leave:vehicle', { vehicleId });
    }
  };

  const joinOrgRoom = (targetOrgId) => {
    if (socket && connected) {
      console.log(`[SOCKET] Requesting join for org:${targetOrgId}`);
      socket.emit('join:org', { targetOrgId });
    }
  };

  const leaveOrgRoom = (targetOrgId) => {
    if (socket && connected) {
      console.log(`[SOCKET] Requesting leave for org:${targetOrgId}`);
      socket.emit('leave:org', { targetOrgId });
    }
  };

  return (
    <SocketContext.Provider
      value={{
        socket,
        connected,
        joinVehicleRoom,
        leaveVehicleRoom,
        joinOrgRoom,
        leaveOrgRoom,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
};
