import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import './index.css';
import { APPWithRouter } from './App';  // Import both default and named export
import reportWebVitals from './reportWebVitals';
import { BrowserRouter } from 'react-router-dom';

const appTheme = createTheme({
  typography: {
    fontFamily:
      '"Manrope Variable", "Avenir Next", "Segoe UI Variable", "Segoe UI", sans-serif',
  },
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ThemeProvider theme={appTheme}>
      <BrowserRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <APPWithRouter /> {/* Correctly use APPWithRouter */}
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
