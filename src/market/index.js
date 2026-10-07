import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import '../index.css';
import { initializeMotionProfile } from '../performance/motionProfile';
import BackendApp from './BackendApp';
initializeMotionProfile();
const theme = createTheme({
  typography: {
    fontFamily: '"Manrope", "Avenir Next", "Segoe UI Variable", "Segoe UI", sans-serif'
  }
});
createRoot(document.getElementById('root')).render(<React.StrictMode><ThemeProvider theme={theme}><BrowserRouter future={{
      v7_startTransition: true,
      v7_relativeSplatPath: true
    }}><BackendApp /></BrowserRouter></ThemeProvider></React.StrictMode>);
