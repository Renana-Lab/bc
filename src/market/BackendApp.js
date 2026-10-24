import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  AppBar,
  Toolbar,
  Typography,
  Button,
  TextField,
  IconButton,
  Tooltip,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Drawer,
  ListItemButton,
  ListItemText,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  InputAdornment,
  Box,
  Collapse,
  Accordion,
  AccordionSummary,
  AccordionDetails
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import DownloadIcon from '@mui/icons-material/Download';
import HomeIcon from '@mui/icons-material/Home';
import GavelIcon from '@mui/icons-material/Gavel';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import TollOutlinedIcon from '@mui/icons-material/TollOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import welPic from '../pages/Home/Illustration_Wel.png';
import loginPic from './assets/tutorial.png';
import startPic from '../pages/AuctionsList/Illustration_Start.png';
import createPic from '../pages/NewAuction/Illustration_Create.png';
import medalPic from '../pages/ShowAuction/medal.png';
import homeIcon from '../images/icons/homepage.png';
import bidIcon from '../images/icons/bid.png';
import campaignIcon from '../images/icons/campaign1.png';
import metaIcon from '../images/icons/meta1.png';
import { faQuestionCircle } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { buildMarketWorkbook, formatReportValue } from './reportExport';
import { analyzeMarketReport } from './analysis';
import { synchronizeMarketClock, useMarketNow } from './clock';
import './backend.css';
import { marketApi as api } from './api';
import homeStyles from '../pages/Home/home.module.scss';
import shellStyles from '../styles/components.module.scss';
import auctionStyles from '../pages/AuctionsList/auctions.module.scss';
import showStyles from '../pages/ShowAuction/show.module.scss';
import newStyles from '../pages/NewAuction/new.module.scss';
import AuctionDatabaseDialog from './AuctionDatabaseDialog';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import CloudQueueOutlinedIcon from '@mui/icons-material/CloudQueueOutlined';
import ApiOutlinedIcon from '@mui/icons-material/ApiOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';

const date = value => value ? new Date(value).toLocaleString() : '-';
const status = a => a.end_at <= Date.now() ? 'Closed' : 'Open';

function IconAction({ title, children, ...props }) {
  return (
    <Tooltip title={title}>
      <span>
        <IconButton aria-label={title} {...props}>
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function ClockDisplay() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const tick = () => { if (!document.hidden) setTime(new Date()); };
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const formatted = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className={`${shellStyles.toolbarPill} ${shellStyles.clockPill}`} title="Current time" aria-label={`Current time ${formatted}`}>
      <ScheduleOutlinedIcon className={shellStyles.toolbarPillIcon} fontSize="small" aria-hidden="true" />
      <span className={shellStyles.toolbarPillValue}>{formatted}</span>
    </div>
  );
}

function Countdown({ end, plain = false }) {
  const now = useMarketNow();
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  return (
    <span className={plain ? 'table-countdown' : 'liveCountdown'}>
      {!plain && <span className="liveCountdownDot" aria-hidden="true" />}
      <span>{seconds ? `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` : 'Closed'}</span>
    </span>
  );
}

function AdminCard({ title, children, defaultOpen = false, action = null }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box className={`adminGlossCard ${open ? 'adminGlossCardOpen' : ''}`}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start', gap: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ color: '#002884', fontWeight: 700 }}>{title}</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {action}
          <IconButton
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            className="adminCollapseButton"
          >
            <KeyboardArrowDownIcon sx={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 75ms ease-out' }} />
          </IconButton>
        </Box>
      </Box>
      <Collapse in={open} timeout={65}>
        <Box sx={{ pt: 2 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}

function PlatformGuideView() {
  const navigate = useNavigate();
  return (
    <div className="market-page-data">
      <div className="accountContainer" style={{ minHeight: 'auto', padding: '1rem 0 3rem' }}>
        <div className="guideHero">
          <h1 className="accountTitle">
            Get Started with Your Marketplace Account
          </h1>
          <p className="accountText">
            Follow these simple steps to set up your account and start participating in our research data auctions.
          </p>
          <Button
            className="guideBackButton"
            onClick={() => navigate("/")}
            startIcon={<ArrowBackIcon />}
          >
            Back to Home
          </Button>
        </div>

        <div className="guideVideo">
          <Accordion defaultExpanded slots={{ heading: "h2" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600, color: '#002884' }}>
                <span className="guideStepNumber">1</span> Create or Sign In to Your Account
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className="accountText" sx={{ textAlign: 'left !important', padding: '0 0 1rem' }}>
                Enter your identifier and log in. A participant account is created automatically the first time you use it.
              </Typography>
              <Button
                variant="contained"
                className="accountActionBtn"
                onClick={() => navigate("/login")}
              >
                Go to Sign-In
              </Button>
            </AccordionDetails>
          </Accordion>

          <Accordion slots={{ heading: "h2" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600, color: '#002884' }}>
                <span className="guideStepNumber">2</span> Check Your Starting Budget
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className="accountText" sx={{ textAlign: 'left !important', padding: '0 0 1rem' }}>
                Every participant account receives a budget for bidding on data auctions. Your available budget is displayed in the top navigation bar at all times.
              </Typography>
            </AccordionDetails>
          </Accordion>

          <Accordion slots={{ heading: "h2" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600, color: '#002884' }}>
                <span className="guideStepNumber">3</span> Open an Auction
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className="accountText" sx={{ textAlign: 'left !important', padding: '0 0 1rem' }}>
                Choose Start an Auction, add the data description and payload, set the minimum bid and closing time, then submit it. Before the first bid, you may adjust only the minimum bid.
              </Typography>
              <Button
                variant="contained"
                className="accountActionBtn"
                onClick={() => navigate("/open-auction")}
              >
                Start an Auction
              </Button>
            </AccordionDetails>
          </Accordion>

          <Accordion slots={{ heading: "h2" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600, color: '#002884' }}>
                <span className="guideStepNumber">4</span> Participate in an Auction
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className="accountText" sx={{ textAlign: 'left !important', padding: '0 0 1rem' }}>
                Open an active auction, review its description and minimum, and submit your total bid within your available budget. The highest bidder receives access to the dataset after the auction closes.
              </Typography>
              <Button
                variant="contained"
                className="accountActionBtn"
                onClick={() => navigate("/auctions-list")}
              >
                View Auctions
              </Button>
            </AccordionDetails>
          </Accordion>
        </div>
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devLogin, setDevLogin] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    api('/auth-options')
      .then(options => { if (live) setDevLogin(options.devLogin); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <main className="accountContainer">
      <div className="accountHeroRow">
        <img
          className="accountIllustration"
          src={loginPic}
          height="250"
          width="200"
          alt="Marketplace account setup illustration"
        />
        <div className="accountQuestion">
          <h1 className="accountTitle">
            Log in to Data Marketplace
          </h1>
          <div className="accountText">
            Log in with your identifier.
          </div>
          <form
            className="accountCard"
            onSubmit={async event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setBusy(true);
              setError('');
              try {
                onLogin(await api('/login', {
                  identifier: data.get('identifier')
                }));
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <TextField
              name="identifier"
              label="Identifier"
              type="text"
              autoComplete="username"
              inputProps={{ maxLength: 200, autoCapitalize: 'none', spellCheck: false }}
              required
              fullWidth
            />
            {error && <p role="alert" style={{ color: '#a51d30', margin: 0 }}>{error}</p>}
            <div className="accountButtons">
              <Button
                type="submit"
                variant="contained"
                disabled={busy}
                className="accountActionBtn"
              >
                {busy ? 'Please wait...' : 'Log in'}
              </Button>
              <Button
                type="button"
                variant="outlined"
                onClick={() => navigate('/guide')}
                style={{ borderRadius: '30px', borderColor: '#9090D0', color: '#9090D0', fontWeight: 600, textTransform: 'none' }}
              >
                Platform Guide
              </Button>
              {devLogin && (
                <Button
                  type="button"
                  variant="outlined"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      onLogin(await api('/dev-login', {}));
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  style={{
                    borderRadius: '30px',
                    borderColor: '#103090',
                    color: '#103090',
                    fontWeight: '600',
                    textTransform: 'none'
                  }}
                >
                  Quick dev sign-in
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}

function HomePageView({ user }) {
  const navigate = useNavigate();
  return (
    <div className={`${shellStyles.pageData} backend-home-page`}><div className={homeStyles.container}>
      <div className={homeStyles.contentContainer}>
        <div className={homeStyles.welcomeSection}>
          <img
            className="homeMarketplaceImage"
            src={welPic}
            height="330"
            width="400"
            alt="Research data marketplace illustration"
          />
          <div className={homeStyles.introText}>
            <h1 style={{ margin: 0, lineHeight: 1.08 }}>Welcome to our data marketplace</h1>
            <br />
            <p style={{ margin: 0, fontSize: '1.2rem' }}>
              This is a research platform, for running <br />
              auctions of personal data using the marketplace budget.
              <br />
              Each auction lasts up to 30 mins.
            </p>
          </div>
        </div>
      </div>
      <div className={homeStyles.buttonsContainer}>
        <Button
          className={homeStyles.primaryButton}
          variant="contained"
          onClick={() => navigate(user ? '/auctions-list' : '/login')}
        >
          Continue
        </Button>
      </div>
    </div>
    </div>
  );
}

function AuctionsListView({ auctions, admin, user, act, refresh, allowPostSubmitEdit }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState('normal');
  const [recordId, setRecordId] = useState(null);

  const filtered = auctions.filter(a =>
    `${a.description} ${a.seller_identifier} ${a.highest}`.toLowerCase().includes(query.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sortMode === 'ending') return a.end_at - b.end_at;
    if (sortMode === 'highest') return b.highest - a.highest;
    if (sortMode === 'bidders') return b.bidders - a.bidders;
    return 0;
  });

  return (
    <section className={`${shellStyles.pageData} backend-auctions-page`}>
      <div className={auctionStyles.page}>
      <div className={auctionStyles.introductionText}>
        <div className={auctionStyles.heroContent}>
          <img
            className={auctionStyles.heroImage}
            src={startPic}
            alt="Research auction marketplace dashboard"
          />
          <div className={auctionStyles.heroCopy}>
            <h1 className={auctionStyles.introductionTitle} aria-label="Auctions">
              Welcome to the Data Marketplace Platform
            </h1>
            <p className={auctionStyles.introductionSubtitle}>
              Scroll down to see all the open and closed auctions.
              <br />
              Do you want to put your data for auction?
            </p>
            <Button
              variant="contained"
              style={{
                backgroundColor: 'rgb(16, 48, 144)',
                color: 'white',
                borderRadius: '30px',
                padding: '12px 22px',
                fontWeight: 700,
              }}
              onClick={() => navigate('/open-auction')}
            >
              Start an auction
            </Button>
          </div>
        </div>
      </div>

      <TableContainer component={Paper} className={auctionStyles.tableShell} style={{ padding: '5px 20px', borderRadius: '20px', width: '100%' }}>
        <div className={auctionStyles.searchBar}>
          <TextField
            fullWidth
            className={auctionStyles.searchInput}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search auctions by description, seller identifier, or exact bid"
            variant="outlined"
            size="small"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon style={{ color: '#002884' }} />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setQuery('')}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
          />
        </div>
        <div className={auctionStyles.tableToolbar}>
          <div className={auctionStyles.tableTools}>
            <label className={auctionStyles.sortControl}>
              Sort
              <select
                value={sortMode}
                onChange={e => setSortMode(e.target.value)}
              >
                <option value="normal">Market order</option>
                <option value="ending">Ending soon</option>
                <option value="highest">Highest bid</option>
                <option value="bidders">Most bidders</option>
              </select>
            </label>
            <Button
              variant="outlined"
              size="small"
              onClick={refresh}
              className={auctionStyles.refreshButton}
            >
              Refresh
            </Button>
          </div>
        </div>
        <div className={auctionStyles.listMeta}>
          <span>
            Showing {sorted.length} of {auctions.length} auctions
          </span>
        </div>
        <div className="tableScrollWrap">
          <Table className={auctionStyles.auctionsTable} aria-label="auctions table">
            <TableHead>
              <TableRow>
                {['Description', 'End Date', 'Auction Status', 'Highest Bid', 'Number Of Bidders', ''].map((h, i) => (
                  <TableCell key={i} align="center" style={{ color: '#0d0d4e', fontWeight: 'bold' }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map(a => {
                const isOpen = a.end_at > Date.now();
                const isPaid = Boolean(a.finalized_at);
                const userWon = isPaid && a.winner_id === user.id;
                const bgColor = userWon ? '#90EE90' : isOpen ? '#BBDEFB' : '#E9E9F6';
                return (
                  <TableRow
                    key={a.id}
                    sx={{
                      backgroundColor: bgColor,
                      transition: 'background-color 65ms ease',
                      '&:hover': {
                        backgroundColor: isOpen ? '#A3CFFA' : '#D0D0F0',
                        cursor: 'pointer',
                      },
                    }}
                    onClick={() => navigate(`/auction/${a.id}`)}
                  >
                    <TableCell align="center" style={{ color: '#0d0d4e', fontWeight: 600 }}>
                      <div>{a.description}</div>
                      <small style={{ color: '#5e638a', display: 'block' }}>{a.seller}</small>
                    </TableCell>
                    <TableCell align="center" style={{ color: '#0d0d4e' }}>
                      <span className={auctionStyles.dateCell}><span>{new Date(a.end_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><small>{new Date(a.end_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</small></span>
                    </TableCell>
                    <TableCell align="center">
                      <Countdown end={a.end_at} plain />
                    </TableCell>
                    <TableCell align="center" style={{ color: '#0d0d4e', fontWeight: 700 }}>
                      {a.highest.toLocaleString()}
                    </TableCell>
                    <TableCell align="center" style={{ color: '#0d0d4e' }}>
                      {a.bidders}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip describeChild enterTouchDelay={0} title={isOpen ? a.seller_id === user.id ? 'Review your auction. The minimum can be edited before the first bid when editing is enabled.' : 'Review the data description and minimum, then submit your total bid within your available budget.' : userWon ? 'This auction has closed. Open it to access the data you won.' : 'This auction has closed. Review its details and bidding history.'}>
                      <Button
                        variant="contained"
                        style={{
                          backgroundColor: userWon ? '#2e7d32' : '#9090D0',
                          color: 'white',
                          borderRadius: '20px',
                          padding: '6px 20px',
                          textTransform: 'uppercase',
                          fontSize: '0.875rem',
                          width: 'max-content',
                        }}
                        component={Link}
                        to={`/auction/${a.id}`}
                        onClick={e => e.stopPropagation()}
                      >
                        View Auction
                      </Button>
                      </Tooltip>
                      {admin && <IconAction title={`Manage database record: ${a.description}`} onClick={e => { e.stopPropagation(); setRecordId(a.id); }}><StorageOutlinedIcon fontSize="small" /></IconAction>}
                      {!admin && allowPostSubmitEdit && a.seller_id === user.id && isOpen && !a.bidders && <IconAction title={`Edit minimum bid: ${a.description}`} onClick={e => { e.stopPropagation(); setRecordId(a.id); }}><EditOutlinedIcon fontSize="small" /></IconAction>}
                      {admin && isOpen && (
                        <IconAction
                          title="Close auction early"
                          onClick={e => {
                            e.stopPropagation();
                            if (window.confirm('Close this auction now? Bidding will stop immediately.')) {
                              act(`/admin/auctions/${a.id}/close`, {});
                            }
                          }}
                        >
                          <StopIcon color="error" />
                        </IconAction>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {!sorted.length && (
          <p style={{ textAlign: 'center', color: '#5e638a', padding: '2rem 0' }}>
            No auctions found.
          </p>
        )}
      </TableContainer>
      </div>
      {recordId && <AuctionDatabaseDialog id={recordId} administrative={admin} onClose={() => setRecordId(null)} refresh={refresh} />}
    </section>
  );
}

function NewAuctionView({ act }) {
  const navigate = useNavigate();
  const [explanation, setExplanation] = useState(null);

  const handleTooltip = (field) => {
    setExplanation(explanation === field ? null : field);
  };

  const renderTooltip = (field, text, tooltipText = text) => (
    <div className="tooltip">
      <label className="tooltiplabe">
        {text}
        <button
          type="button"
          onClick={() => handleTooltip(field)}
          className="circleIcon"
          aria-label={`Info about ${text}`}
        >
          <FontAwesomeIcon icon={faQuestionCircle} />
        </button>
      </label>
      {explanation === field && (
        <div className="description">{tooltipText}</div>
      )}
    </div>
  );

  return (
    <div className="market-page-data">
      <div className={`${newStyles.direction} backend-create-layout`}>
        <img
          className={`${newStyles.Image} backend-create-image`}
          src={createPic}
          alt="Create a research data auction"
        />
        <form
          className={`${newStyles.form} backend-create-form`}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = Object.fromEntries(new FormData(form));
            const min = data.minimum ?? data.minimumContribution;
            const dur = data.minutes ?? data.auctionDuration;
            const desc = data.description ?? data.dataDescription;
            const pay = data.payload ?? data.dataForSell;
            const result = await act('/auctions', {
              ...data,
              description: desc,
              payload: pay,
              minimum: Number(min),
              minutes: Number(dur),
            });
            if (result) navigate(`/auction/${result.id}`);
          }}
        >
          <h1 className="introductionTitle" style={{ margin: '0 0 1rem' }}>
            Create Auction
          </h1>

          <Box
            sx={{
              width: '85%',
              px: 1.25,
              py: 1,
              border: '1px solid rgba(16, 48, 144, 0.12)',
              borderRadius: 1.5,
              backgroundColor: 'rgba(248, 250, 255, 0.58)',
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, color: '#002884' }}>
              Auction destination
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.15 }}
            >
              This auction will be opened in this marketplace instance.
            </Typography>
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                mt: 0.75,
                px: 1,
                py: 0.25,
                border: '1px solid rgba(16, 48, 144, 0.14)',
                borderRadius: 999,
                backgroundColor: 'rgba(255, 255, 255, 0.55)',
                color: '#0d0d4e',
                fontSize: '0.82rem',
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              Live
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.55, overflowWrap: 'anywhere', opacity: 0.76 }}
            >
              Marketplace instance active
            </Typography>
          </Box>

          {renderTooltip('minBid', 'Minimum Bid', 'The lowest total bid accepted for this auction. You can adjust only this value before the first bid, if editing is enabled.')}
          <TextField
            type="number"
            sx={{ width: '85%' }}
            name="minimumContribution"
            defaultValue={50}
            required
            inputProps={{ min: 1, max: 1000000000, 'aria-label': 'Minimum Bid' }}
          />

          {renderTooltip('dataDescription', 'Description of the Data', 'Describe what buyers receive. This description is visible to everyone and cannot be changed after submission.')}
          <TextField
            sx={{ width: '85%' }}
            name="dataDescription"
            required
            inputProps={{ maxLength: 300, 'aria-label': 'Description of the Data' }}
          />

          {renderTooltip('dataForSale', 'Data For Sell', 'Enter the data being sold. It is released to the winning bidder after the auction closes. This cannot be changed after submission.')}
          <TextField
            sx={{ width: '85%' }}
            name="dataForSell"
            required
            inputProps={{ maxLength: 50000, 'aria-label': 'Data for sale' }}
          />

          {renderTooltip('auctionTime', 'Auction Duration (1-30 min)', 'Bidding starts on submission and ends after this many minutes. The duration cannot be changed after submission.')}
          <TextField
            sx={{ width: '85%' }}
            type="number"
            name="auctionDuration"
            defaultValue={25}
            required
            inputProps={{ min: 1, max: 30, 'aria-label': 'Auction Duration (1-30 min)' }}
          />

          <div
            style={{
              width: '85%',
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: '2rem',
            }}
          >
            <Button
              style={{
                backgroundColor: '#9090D0',
                color: 'white',
                borderRadius: '20px',
                padding: '10px 20px',
                width: '300px',
                fontWeight: 700,
              }}
              type="submit"
              variant="contained"
              aria-label="Create auction"
            >
              CREATE AUCTION
            </Button>
          </div>
        </form>
      </div>

      <div
        style={{
          textAlign: 'center',
          marginTop: '2rem',
          paddingBottom: '2rem',
        }}
      >
        <Button
          variant="contained"
          className="returnButton"
          style={{
            backgroundColor: '#103090',
            color: 'white',
            borderRadius: '20px',
            padding: '10px 20px',
            width: '650px',
            maxWidth: '90%',
            fontWeight: 700,
          }}
          onClick={() => navigate('/auctions-list')}
        >
          RETURN TO AUCTIONS MAIN SCREEN
        </Button>
      </div>
    </div>
  );
}

function AuctionDetailsView({ user, act, revision, allowPostSubmitEdit, canExportTransactions = false }) {
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const { address } = useParams();
  const navigate = useNavigate();
  const [auction, setAuction] = useState(null);
  const [error, setError] = useState('');
  const key = useRef(null);
  const [bidPending, setBidPending] = useState(false);
  const [bidNotice, setBidNotice] = useState(null);
  const [totalBid, setTotalBid] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  useEffect(() => { setTotalBid(''); setBidNotice(null); }, [address]);

  useEffect(() => {
    let live = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const val = await api(`/auctions/${address}`);
        if (live) { setAuction(val); setError(''); }
      } catch (err) {
        if (live) setError(err.message);
      } finally {
        pending = false;
      }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [address, revision, editRevision]);

  if (!auction) {
    return (
      <div className="market-page-data">
        <p role="status" style={{ textAlign: 'center', color: '#002884', fontSize: '1.2rem', padding: '3rem' }}>
          {error || 'Loading auction...'}
        </p>
      </div>
    );
  }

  const a = auction;
  const isAuctionActive = a.end_at > Date.now();
  const isManager = a.seller_id === user.id;

  return (
    <div className="market-page-data">
      <h1 className="introductionTitle" style={{ textAlign: 'center', fontSize: '2.5rem', margin: '0 0 0.5rem' }}>
        {a.description}
      </h1>
      <p style={{ textAlign: 'center', color: '#5e638a', margin: '0 0 2rem' }}>
        Auction # {a.id}
      </p>
      {allowPostSubmitEdit && isManager && isAuctionActive && !a.bidders && !a.finalized_at && <Box sx={{ textAlign: 'center' }}><Button startIcon={<EditOutlinedIcon />} onClick={() => setEditing(true)}>Edit minimum bid</Button></Box>}
      {editing && <AuctionDatabaseDialog id={a.id} administrative={false} onClose={() => setEditing(false)} refresh={() => setEditRevision(value => value + 1)} />}

      <div className={`${showStyles.page} backend-show-page`}>
        <div className={showStyles.campaignInfo}>
          <h2 style={{ color: '#002884', margin: '0 0 1rem' }}>Auction Details</h2>
          <hr style={{ border: 0, borderTop: '1px solid rgba(16, 48, 144, 0.12)', margin: '1rem 0 1.5rem' }} />

          <div className="introductionDetail">
            <span className="introductionLabel">Data description: </span>
            <span className="introductionText">{a.description}</span>
          </div>

          <div className="introductionDetail">
            <span className="introductionLabel">Seller identifier: </span>
            <span className="introductionText">{a.seller}</span>
          </div>

          <div className="introductionDetail">
            <span className="introductionLabel">Time left: </span>
            <Countdown end={a.end_at} />
          </div>

          <div className="introductionDetail">
            <span className="introductionLabel">Minimum bid required: </span>
            <span className="introductionText">{a.minimum}</span>
          </div>

          <div className="introductionDetail">
            <span className="introductionLabel">Highest bid recorded: </span>
            <span className="introductionText">{a.highest}</span>
          </div>

          <div className="introductionDetail">
            <span className="introductionLabel">Number of bidders: </span>
            <span className="introductionText">{a.bidders}</span>
          </div>

        </div>

        {isAuctionActive && !isManager && (
          <div className={showStyles.contributeForm}>
            <Typography variant="h6" textAlign="center" sx={{ marginBottom: '1rem', color: '#002884', fontWeight: 700 }}>
              Remaining Budget: {user.budget}
            </Typography>
            <form
              onSubmit={async event => {
                event.preventDefault();
                if (bidPending) return;
                const total = Number(totalBid);
                const amount = total - a.my_bid;
                const cost = a.winner_id === user.id ? amount : total;
                if (!Number.isSafeInteger(total) || total < a.minimum || total <= a.highest || amount <= 0 || cost > user.budget) {
                  setBidNotice({ severity: 'error', text: `Your total bid must be at least ${Math.max(a.minimum, a.highest + 1, a.my_bid + 1)} and the increase must fit your remaining budget (${user.budget}).` });
                  return;
                }
                setBidPending(true);
                setBidNotice(null);
                if (!key.current || key.current.amount !== amount) {
                  key.current = { amount, id: crypto.randomUUID() };
                }
                try {
                  const result = await act(`/auctions/${a.id}/bid`, { amount }, { 'Idempotency-Key': key.current.id });
                  if (result) {
                    key.current = null;
                    setTotalBid('');
                    setBidNotice({ severity: 'success', text: 'Bid placed successfully!' });
                    try { setAuction(await api(`/auctions/${a.id}`)); } catch { /* Polling will refresh the confirmed bid. */ }
                  } else setBidNotice({ severity: 'error', text: 'Your bid was not accepted. Review the latest highest bid and your budget, then try again.' });
                } catch (err) {
                  setBidNotice({ severity: 'error', text: err.message });
                } finally { setBidPending(false); }
              }}
            >
              <div className="bidFieldHeading">
                <label htmlFor="total-bid">Total Bid</label>
                <Tooltip enterTouchDelay={0} title={`Enter your total bid, including any amount you already bid (${a.my_bid}). When you lead, only the increase is reserved; otherwise the full total is reserved. Minimum accepted now: ${Math.max(a.minimum, a.highest + 1, a.my_bid + 1)}. If another bidder takes the lead, your reserved budget is released.`}>
                  <IconButton size="small" aria-label="How total bids work">?</IconButton>
                </Tooltip>
              </div>
              <TextField
                id="total-bid"
                name="amount"
                type="number"
                value={totalBid}
                onChange={event => setTotalBid(event.target.value)}
                disabled={bidPending}
                required
                fullWidth
                className="totalBidInput"
                inputProps={{ min: Math.max(a.minimum, a.highest + 1, a.my_bid + 1), max: Math.min(1000000000, (a.winner_id === user.id ? a.my_bid : 0) + user.budget), step: 1, 'aria-describedby': bidNotice ? 'bid-feedback' : undefined }}
              />
              {bidNotice && <Alert id="bid-feedback" severity={bidNotice.severity} role={bidNotice.severity === 'error' ? 'alert' : 'status'} sx={{ mt: 2 }}>{bidNotice.text}</Alert>}
              <Button
                type="submit"
                disabled={bidPending}
                variant="contained"
                style={{
                  marginTop: '1.5rem',
                  height: '2.5rem',
                  borderRadius: '1rem',
                  backgroundColor: '#002884',
                  color: '#D8DCF0',
                  fontWeight: 600,
                  width: '100%',
                }}
              >
                {bidPending ? 'Submitting...' : 'Submit your bid'}
              </Button>
            </form>
          </div>
        )}

        {a.payload !== undefined && (
          <div className={showStyles.contributeForm} style={{ background: 'linear-gradient(145deg, #ffffff 0%, #f7f9ff 100%)' }}>
            <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
              <img src={medalPic} width="80" alt="Auction winner medal" />
              <div className="winnerTitle">Congrats!</div>
              <div className="winnerLabel">You won the auction and have now access to the data</div>
            </div>
            <Button variant="contained" onClick={() => setDataOpen(true)}>View Data</Button>
            <Dialog open={dataOpen} onClose={() => setDataOpen(false)} fullWidth maxWidth="sm" aria-labelledby="acquired-data-title">
              <DialogTitle id="acquired-data-title">Data acquired</DialogTitle>
              <DialogContent>
              <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'inherit' }}>
                {a.payload}
              </pre>
              </DialogContent>
              <DialogActions><Button onClick={() => setDataOpen(false)}>Close</Button></DialogActions>
            </Dialog>
          </div>
        )}

        {!isAuctionActive && !isManager && a.my_bid > 0 && a.payload === undefined && (
          <div className={showStyles.contributeForm} style={{ textAlign: 'center', padding: '1.5rem', background: '#f8faff', borderRadius: '12px', border: '1px solid #d9dff2' }}>
            <Typography variant="h6" sx={{ color: '#002884', fontWeight: 700, mb: 1 }}>
              Auction concluded
            </Typography>
            <Typography variant="body1" sx={{ color: '#5e638a' }}>
              You did not win the auction. Your bid has been refunded.
            </Typography>
          </div>
        )}
      </div>

      {a.can_view_history && <div style={{ marginTop: '2rem', textAlign: 'center' }}>
        <Button variant="contained" onClick={() => setHistoryOpen(true)}>Display Bidding History</Button>
        <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} fullWidth maxWidth="md" aria-labelledby="bidding-history-title">
        <DialogTitle id="bidding-history-title">Bidding History</DialogTitle>
        <DialogContent>
        <TableContainer component={Paper} className="auctionsTableShell">
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>Auction # {a.id}</Typography>
            {canExportTransactions && a.bids?.length > 0 && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={() => {
                  const headers = ['Bidder Identifier', 'Tx Amount', 'Cumulative Bid', 'Bid Time (UTC)'];
                  const cell = v => `"${String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
                  const rows = a.bids.map(b => [b.bidder, b.amount, b.cumulative, formatReportValue('created_at', b.created_at)]);
                  const csv = [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `auction-${a.id}-bids.csv`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
                style={{ borderRadius: '20px', borderColor: '#103090', color: '#103090', fontWeight: 600 }}
              >
                Export Transactions
              </Button>
            )}
          </Box>
          <div className="tableScrollWrap">
            <Table aria-label="bids history">
              <TableHead>
                <TableRow>
                  {['Bidder Identifier', 'Tx Amount', 'Cumulative Bid', 'Bid Time'].map((h, i) => (
                    <TableCell key={i} align="center" style={{ color: '#0d0d4eff', fontWeight: 'bold' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {a.bids.map(b => (
                  <TableRow key={b.id}>
                    <TableCell align="center" style={{ fontWeight: 600 }}>{b.bidder}</TableCell>
                    <TableCell align="center">{b.amount}</TableCell>
                    <TableCell align="center" style={{ fontWeight: 700 }}>{b.cumulative}</TableCell>
                    <TableCell align="center">{date(b.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!a.bids.length && (
            <p style={{ textAlign: 'center', color: '#5e638a', padding: '1.5rem 0' }}>
              No bids placed yet.
            </p>
          )}
        </TableContainer>
        </DialogContent>
        <DialogActions><Button onClick={() => setHistoryOpen(false)}>Close</Button></DialogActions>
        </Dialog>
      </div>}

      <div style={{ textAlign: 'center', marginTop: '2rem' }}>
        <Button
          variant="contained"
          style={{
            height: '2.5rem',
            borderRadius: '1rem',
            backgroundColor: '#103090',
            color: '#D8DCF0',
            fontWeight: 600,
            width: 'min(400px, 90%)',
          }}
          onClick={() => navigate('/auctions-list')}
        >
          Return To Auctions Main Screen
        </Button>
      </div>
    </div>
  );
}

function BotItem({ bot, act }) {
  const hourlyLimit = Math.ceil(3600 / bot.interval_seconds);
  return (
    <form
      className="backendBotRow"
      onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        act(`/admin/bots/${bot.user_id}`, {
          interval_seconds: Number(data.get('interval')),
          budget: Number(data.get('budget')),
          enabled: data.has('enabled')
        });
      }}
    >
      <div className="backendBotIdentity">
        <div className="backendBotTitle">
          <strong>{bot.name}</strong>
          <span className={`backendBotStatus ${bot.running ? 'isRunning' : ''}`}>{bot.running ? 'Running' : 'Stopped'}</span>
          {!bot.enabled && <span className="backendBotStatus">Disabled</span>}
        </div>
        <small>{bot.cycles} cycles / {bot.sent} bids</small>
        <small>Available budget: {bot.budget}</small>
        <small>Last cycle {date(bot.last_seen)}</small>
      </div>

      <div className="backendBotSettings">
        <TextField
          name="interval"
          label="Interval (seconds)"
          type="number"
          defaultValue={bot.interval_seconds}
          size="small"
          inputProps={{ min: 10, max: 3600 }}
        />
        <TextField
          name="budget"
          label="Bot budget"
          type="number"
          defaultValue={bot.total_budget}
          size="small"
          inputProps={{ min: 0, max: 1000000000 }}
        />
      </div>

      <div className="backendBotActions">
        <FormControlLabel
          control={<Checkbox name="enabled" defaultChecked={Boolean(bot.enabled)} />}
          label="Enabled"
        />
        <Button type="submit" variant="outlined" size="small" style={{ borderRadius: '20px' }}>
          Save settings
        </Button>
        <IconAction title="Start bot" onClick={() => act(`/admin/bots/${bot.user_id}`, { running: true, enabled: true })}>
          <PlayArrowIcon color="success" />
        </IconAction>
        <IconAction title="Stop bot" onClick={() => act(`/admin/bots/${bot.user_id}`, { running: false })}>
          <StopIcon color="error" />
        </IconAction>
        <Button size="small" onClick={() => act(`/admin/bots/${bot.user_id}/run`, {})}>Run now</Button>
        <IconAction
          title="Remove bot"
          onClick={() => window.confirm(`Remove ${bot.name} from the Bot Command Center? Its audit history will be kept.`) && act(`/admin/bots/${bot.user_id}/remove`, {})}
        >
          <DeleteOutlineIcon color="error" fontSize="small" />
        </IconAction>
        <small className="backendBotUsage">Random auction / up to {hourlyLimit} bids per hour</small>
      </div>
    </form>
  );
}

function BatchAuctionStudio({ act, notify }) {
  const [defaults, setDefaults] = useState({
    rowCount: 3,
    descriptionPrefix: 'Research dataset',
    dataPrefix: 'Personal research records',
    minimumContribution: 50,
    auctionDuration: 25,
  });
  const [rows, setRows] = useState([
    { id: 1, description: 'Research dataset 01', payload: 'Personal research records 01', minimum: 50, minutes: 25 },
    { id: 2, description: 'Research dataset 02', payload: 'Personal research records 02', minimum: 50, minutes: 25 },
    { id: 3, description: 'Research dataset 03', payload: 'Personal research records 03', minimum: 50, minutes: 25 },
  ]);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);

  const generateDraft = (count = defaults.rowCount) => {
    const next = [];
    for (let i = 1; i <= count; i++) {
      const pad = String(i).padStart(2, '0');
      next.push({
        id: Date.now() + i,
        description: `${defaults.descriptionPrefix} ${pad}`,
        payload: `${defaults.dataPrefix} ${pad}`,
        minimum: Number(defaults.minimumContribution) || 50,
        minutes: Number(defaults.auctionDuration) || 25,
      });
    }
    setRows(next);
  };

  const addRow = () => {
    const i = rows.length + 1;
    const pad = String(i).padStart(2, '0');
    setRows(current => [
      ...current,
      {
        id: Date.now() + i,
        description: `${defaults.descriptionPrefix} ${pad}`,
        payload: `${defaults.dataPrefix} ${pad}`,
        minimum: Number(defaults.minimumContribution) || 50,
        minutes: Number(defaults.auctionDuration) || 25,
      }
    ]);
  };

  const updateRow = (idx, field, value) => {
    setRows(current => current.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };

  const removeRow = idx => {
    setRows(current => current.filter((_, i) => i !== idx));
  };

  const getRowError = r => {
    if (!r.description?.trim()) return 'Description is required';
    if (r.description.trim().length > 300) return 'Description must be at most 300 characters';
    if (!r.payload?.trim()) return 'Data is required';
    if (r.payload.trim().length > 50000) return 'Data must be at most 50000 characters';
    if (!Number.isSafeInteger(Number(r.minimum)) || Number(r.minimum) < 1 || Number(r.minimum) > 1000000000) return 'Min bid must be a whole number from 1 to 1000000000';
    if (!Number.isSafeInteger(Number(r.minutes)) || Number(r.minutes) < 1 || Number(r.minutes) > 30) return 'Duration must be a whole number from 1 to 30 minutes';
    return '';
  };

  const readyCount = rows.filter(r => !getRowError(r)).length;
  const issuesCount = rows.length - readyCount;

  const handleSubmit = async () => {
    if (!rows.length) { notify('No auction rows to create'); return; }
    if (rows.length > 50) { notify('Batch cannot exceed 50 auctions'); return; }
    const invalid = rows.find(r => getRowError(r));
    if (invalid) { notify(`Row issue: ${getRowError(invalid)}`); return; }
    setBusy(true);
    try {
      const payload = rows.map(r => ({
        description: r.description.trim(),
        payload: r.payload.trim(),
        minimum: Number(r.minimum),
        minutes: Number(r.minutes)
      }));
      const res = await act('/admin/batch', { auctions: payload });
      if (res) {
        notify(`Created ${payload.length} auctions successfully!`);
      }
    } finally {
      setBusy(false);
    }
  };

  const loadExample = () => {
    setRows([
      { id: Date.now() + 1, description: 'Grp 1: apps on phone', payload: '42 apps dataset', minimum: 100, minutes: 10 },
      { id: Date.now() + 2, description: 'Grp 1: doctor visits', payload: '3 visits health record', minimum: 100, minutes: 10 },
      { id: Date.now() + 3, description: 'Grp 2: apps on phone', payload: '58 apps dataset', minimum: 100, minutes: 10 },
    ]);
  };

  const toggleJson = () => {
    if (!showJson) {
      setJsonText(JSON.stringify(rows.map(({ description, payload, minimum, minutes }) => ({ description, payload, minimum, minutes })), null, 2));
    }
    setShowJson(!showJson);
  };

  const applyJson = () => {
    try {
      const text = jsonText.trim();
      if (!text) throw new Error('Input text is empty');
      let items = [];
      if (text.startsWith('[') || text.startsWith('{')) {
        const parsed = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } else {
        // Delimited lines format: description | payload | minimum | minutes (OG format)
        items = text
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .filter(line => {
            const lower = line.toLowerCase();
            return !(lower.includes('description') && lower.includes('minimum'));
          })
          .map(line => {
            const parts = line.split(/[|\t,]/).map(p => p.trim().replace(/^"(.*)"$/, '$1'));
            return {
              description: parts[0] || '',
              payload: parts[1] || '',
              minimum: parts[2] || defaults.minimumContribution || 50,
              minutes: parts[3] || defaults.auctionDuration || 25,
            };
          });
      }
      if (!items.length) throw new Error('No auction items found');
      if (items.length > 50) throw new Error('Batch cannot exceed 50 auctions');
      setRows(items.map((item, i) => ({
        id: Date.now() + i,
        description: item.description || item.dataDescription || '',
        payload: item.payload || item.dataForSell || '',
        minimum: Number(item.minimum || item.minimumContribution || defaults.minimumContribution || 50),
        minutes: Number(item.minutes || item.auctionDuration || defaults.auctionDuration || 25)
      })));
      setShowJson(false);
    } catch (err) {
      notify(`Import error: ${err.message}`);
    }
  };

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        Pick a template count, fine-tune the rows inline, or edit raw JSON/delimited text before creating the batch.
      </Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1.4fr 1fr 1fr 1fr' }, gap: 1.5, p: 2, borderRadius: 2, background: '#f7f9fc', border: '1px solid #e3e8f4', alignItems: 'center' }}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Start with
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {[3, 5, 10, 20, 30, 50].map(cnt => (
              <Button
                key={cnt}
                size="small"
                variant={defaults.rowCount === cnt ? 'contained' : 'outlined'}
                onClick={() => { setDefaults(d => ({ ...d, rowCount: cnt })); generateDraft(cnt); }}
                style={{ borderRadius: '20px', minWidth: '36px', padding: '2px 8px' }}
              >
                {cnt}
              </Button>
            ))}
          </Box>
        </Box>
        <TextField
          label="Description prefix"
          size="small"
          value={defaults.descriptionPrefix}
          onChange={e => setDefaults(d => ({ ...d, descriptionPrefix: e.target.value }))}
        />
        <TextField
          label="Data prefix"
          size="small"
          value={defaults.dataPrefix}
          onChange={e => setDefaults(d => ({ ...d, dataPrefix: e.target.value }))}
        />
        <TextField
          label="Min bid"
          type="number"
          size="small"
          value={defaults.minimumContribution}
          onChange={e => setDefaults(d => ({ ...d, minimumContribution: Number(e.target.value) }))}
          inputProps={{ min: 1 }}
        />
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ padding: '4px 10px', borderRadius: '12px', background: '#eef2fb', color: '#103090', fontSize: '12px', fontWeight: 700 }}>
            {rows.length}/50 rows
          </span>
          <span style={{ padding: '4px 10px', borderRadius: '12px', background: '#e8f5e9', color: '#2e7d32', fontSize: '12px', fontWeight: 700 }}>
            {readyCount} ready
          </span>
          {issuesCount > 0 && (
            <span style={{ padding: '4px 10px', borderRadius: '12px', background: '#ffebee', color: '#c62828', fontSize: '12px', fontWeight: 700 }}>
              {issuesCount} issues
            </span>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" onClick={() => generateDraft()} style={{ borderRadius: '20px' }}>
            Generate Draft
          </Button>
          <Button size="small" variant="outlined" onClick={loadExample} style={{ borderRadius: '20px' }}>
            Load Example
          </Button>
          <Button size="small" variant="outlined" onClick={addRow} disabled={rows.length >= 50} style={{ borderRadius: '20px' }}>
            Add Row
          </Button>
          <Button size="small" variant="text" onClick={toggleJson} style={{ textTransform: 'none' }}>
            {showJson ? 'Hide JSON' : 'Import / JSON'}
          </Button>
          <Button size="small" variant="text" color="error" onClick={() => setRows([])} style={{ textTransform: 'none' }}>
            Clear Draft
          </Button>
        </Box>
      </Box>

      {showJson && (
        <Box sx={{ display: 'grid', gap: 1.5, p: 2, borderRadius: 2, background: '#f5f7fa', border: '1px solid #d0d7e5' }}>
          <TextField
            label="Auction batch JSON"
            multiline
            minRows={5}
            value={jsonText}
            onChange={e => setJsonText(e.target.value)}
            fullWidth
            placeholder='[{"description":"Research dataset 01","payload":"Private data","minimum":50,"minutes":25}]'
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button size="small" variant="contained" onClick={applyJson} style={{ backgroundColor: '#103090', borderRadius: '20px' }}>
              Apply JSON to Rows
            </Button>
          </Box>
        </Box>
      )}

      {rows.length > 0 && (
        <div className="tableScrollWrap" style={{ border: '1px solid #e2e7f2', borderRadius: '8px' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell style={{ fontWeight: 700, width: '40px' }}>#</TableCell>
                <TableCell style={{ fontWeight: 700 }}>Description</TableCell>
                <TableCell style={{ fontWeight: 700 }}>Data for sale</TableCell>
                <TableCell style={{ fontWeight: 700, width: '90px' }}>Min bid</TableCell>
                <TableCell style={{ fontWeight: 700, width: '90px' }}>Duration (m)</TableCell>
                <TableCell style={{ fontWeight: 700, width: '80px' }}>Status</TableCell>
                <TableCell style={{ width: '60px' }}></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, idx) => {
                const err = getRowError(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell>{idx + 1}</TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        fullWidth
                        value={row.description}
                        onChange={e => updateRow(idx, 'description', e.target.value)}
                        error={!row.description.trim()}
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        fullWidth
                        value={row.payload}
                        onChange={e => updateRow(idx, 'payload', e.target.value)}
                        error={!row.payload.trim()}
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        type="number"
                        value={row.minimum}
                        onChange={e => updateRow(idx, 'minimum', e.target.value)}
                        error={!Number.isSafeInteger(Number(row.minimum)) || Number(row.minimum) < 1 || Number(row.minimum) > 1000000000}
                        inputProps={{ min: 1, max: 1000000000, step: 1, 'aria-label': `Minimum bid row ${idx + 1}` }}
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        type="number"
                        value={row.minutes}
                        onChange={e => updateRow(idx, 'minutes', e.target.value)}
                        error={!Number.isSafeInteger(Number(row.minutes)) || Number(row.minutes) < 1 || Number(row.minutes) > 30}
                        inputProps={{ min: 1, max: 30, step: 1, 'aria-label': `Duration row ${idx + 1}` }}
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        title={err || 'Ready for creation'}
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          fontSize: '11px',
                          fontWeight: 700,
                          backgroundColor: err ? '#ffebee' : '#e8f5e9',
                          color: err ? '#c62828' : '#2e7d32',
                        }}
                      >
                        {err ? 'Fix' : 'Ready'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" onClick={() => removeRow(idx)} aria-label="Remove row">
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {!rows.length && (
        <Box sx={{ p: 3, textAlign: 'center', border: '1px dashed #c4cde0', borderRadius: 2, background: '#fafbff' }}>
          <Typography variant="body2" color="text.secondary">
            No rows in batch draft. Click Generate Draft or Add Row to start.
          </Typography>
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
        <Button
          variant="contained"
          disabled={busy || !rows.length}
          onClick={handleSubmit}
          style={{ backgroundColor: '#103090', borderRadius: '20px', padding: '8px 24px' }}
        >
          {busy ? 'Creating batch...' : `Create batch (${rows.length} auctions)`}
        </Button>
      </Box>
    </Box>
  );
}

function AdminView({ auctions, act, revision, notify }) {
  const [state, setState] = useState(null);
  const [adminReload, setAdminReload] = useState(0);
  const [inspect, setInspect] = useState('');
  const [historical, setHistorical] = useState(null);
  const [reportFromDate, setReportFromDate] = useState('');
  const [reportToDate, setReportToDate] = useState('');
  const [reportIncludeAll, setReportIncludeAll] = useState(true);

  useEffect(() => {
    let live = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const val = await api('/admin/state');
        if (live) setState(val);
      } catch (err) {
        if (live) notify(err.message);
      } finally {
        pending = false;
      }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [revision, notify, adminReload]);

  if (!state) {
    return (
      <div className="market-page-data">
        <p style={{ textAlign: 'center', color: '#002884', fontSize: '1.2rem', padding: '3rem' }}>
          Loading Admin Zone...
        </p>
      </div>
    );
  }

  const exportReport = async kind => {
    const report = await api('/admin/report');
    if (!reportIncludeAll && (reportFromDate || reportToDate)) {
      const fromMs = reportFromDate ? new Date(`${reportFromDate}T00:00:00`).getTime() : 0;
      const toMs = reportToDate ? new Date(`${reportToDate}T23:59:59.999`).getTime() : Infinity;
      report.auctions = report.auctions.filter(a => a.end_at >= fromMs && a.end_at <= toMs);
      const auctionIds = new Set(report.auctions.map(a => a.id));
      report.bids = report.bids.filter(b => auctionIds.has(b.auction_id));
      report.ledger = report.ledger.filter(l => !l.auction_id || auctionIds.has(l.auction_id));
    }
    Object.assign(report, analyzeMarketReport(report));
    const downloadBlob = (data, type, filename) => {
      const url = URL.createObjectURL(new Blob([data], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    if (kind === 'json') return downloadBlob(JSON.stringify(report, null, 2), 'application/json', 'market-report.json');
    if (kind === 'csv') {
      const headers = ['id', 'auction_id', 'user_id', 'amount', 'cumulative', 'budget_before', 'budget_after', 'created_at'];
      const cell = v => `"${String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
      return downloadBlob([headers.map(h => h.endsWith('_at') ? `${h} (UTC)` : h), ...report.bids.map(r => headers.map(h => formatReportValue(h, r[h])))].map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv', 'market-bids.csv');
    }
    const tables = ['users', 'auctions', 'bids', 'ledger', 'events', 'snapshots', 'rounds', 'activity', 'participants', 'payments', 'flags'].map(name => ({
      name,
      rows: (report[name] || []).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])))
    }));
    if (kind === 'xls') return downloadBlob(buildMarketWorkbook(tables), 'application/vnd.ms-excel', 'market-workbook.xls');

    const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const tableHtml = tables.map(({ name, rows }) =>
      `<h2>${escapeHtml(name)}</h2><table><tr>${Object.keys(rows[0] || {}).map(h => `<th>${escapeHtml(h.endsWith('_at') ? `${h} (UTC)` : h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${Object.entries(r).map(([key, value]) => `<td>${escapeHtml(formatReportValue(key, value))}</td>`).join('')}</tr>`).join('')}</table>`
    ).join('');
    downloadBlob(`<!doctype html><html><meta charset="utf-8"><title>Data Marketplace report</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%;font-size:11px}td,th{padding:6px;border:1px solid #ccc;overflow-wrap:anywhere}h2{break-before:auto}@media print{table{font-size:8px}}</style><h1>Data Marketplace Report</h1><p>${escapeHtml(date(report.generatedAt))}</p>${tableHtml}</html>`, 'text/html', 'data-marketplace-report.html');
  };

  const botSummary = {
    registered: state.bots.length,
    running: state.bots.filter(b => b.running).length,
    cycles: state.bots.reduce((sum, b) => sum + (b.cycles || 0), 0),
    bids: state.bots.reduce((sum, b) => sum + (b.sent || 0), 0),
  };

  const activeAuctionsCount = auctions.filter(a => !a.finalized_at && a.end_at > Date.now()).length;
  const system = state.system;
  const resourceLinks = {
    frontend: 'https://us-east-1.console.aws.amazon.com/amplify/apps/d1480nbd1jz398/branches/main',
    server: 'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#InstanceDetails:instanceId=i-0dced63de1425ce81',
    database: 'https://us-east-1.console.aws.amazon.com/systems-manager/session-manager/i-0dced63de1425ce81?region=us-east-1',
    source: 'https://github.com/Renana-Lab/bc/tree/codex/backend-marketplace-release',
    api: 'https://54.83.80.133.nip.io/api/market/session'
  };
  const componentLinks = {
    Frontend: resourceLinks.frontend,
    'API service': resourceLinks.server,
    Database: resourceLinks.database,
    Scheduler: resourceLinks.database,
    'Bot engine': '#admin-bots',
    'Evidence and reports': '#admin-reports'
  };
  const formatBytes = value => {
    if (!Number.isFinite(value)) return 'In memory';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  };
  const formatUptime = seconds => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ');
  };
  const componentRows = [
    { name: 'Frontend', role: 'Participant and admin interface', host: 'AWS Amplify / React + Vite', status: 'online', detail: 'Static assets and SPA routing' },
    { name: 'API service', role: 'Authentication and marketplace rules', host: `AWS EC2 / Node.js ${system.runtime.node}`, status: system.runtime.status, detail: `Process uptime ${formatUptime(system.runtime.uptime_seconds)}` },
    { name: 'Database', role: 'Users, auctions, bids, budgets and audit evidence', host: `${system.database.engine} / WAL`, status: system.database.status, detail: formatBytes(system.database.size_bytes) },
    { name: 'Scheduler', role: 'Auction boundaries, finalization and bot cycles', host: `Server tick every ${system.scheduler.tick_interval_ms / 1000}s`, status: system.scheduler.status, detail: system.scheduler.last_activity_at ? `Last activity ${date(system.scheduler.last_activity_at)}` : 'Waiting for first activity record' },
    { name: 'Bot engine', role: 'Random auction selection and controlled bidding', host: 'Coordinated inside the API service', status: botSummary.running ? 'active' : 'idle', detail: `${botSummary.registered} registered / ${botSummary.running} running` },
    { name: 'Evidence and reports', role: 'Ledger, events, snapshots and exports', host: 'SQLite + Admin report generator', status: 'online', detail: `${system.counts.ledger_entries} ledger entries / ${system.counts.snapshots} snapshots` }
  ];
  const accessRows = [
    {
      name: 'Frontend',
      access: 'AWS Console > Amplify > Data Marketplace > main',
      change: 'Edit the React source on GitHub, run the production checks, then deploy the generated build to Amplify.',
      reference: 'Amplify app d1480nbd1jz398'
    },
    {
      name: 'API service',
      access: 'AWS Console > Systems Manager > Run Command > marketplace EC2 instance',
      change: 'Application code lives in /opt/bc-marketplace. Deploy the release branch, then restart and verify the bc-marketplace service.',
      reference: 'EC2 i-0dced63de1425ce81 / systemd: bc-marketplace'
    },
    {
      name: 'Database',
      access: 'Use the auction editor, Users and budgets, and Market manager below for normal changes. Use Systems Manager only for maintenance.',
      change: 'Schema changes belong in scripts/market/store.js. Back up the database before a migration or direct maintenance and never edit the live file while the service is writing.',
      reference: `Live file ${system.database.path}`,
      warning: 'Backup first: MARKET_DATA_DIR=/var/lib/bc-marketplace node scripts/market/backup.js'
    },
    {
      name: 'Scheduler',
      access: 'Admin Zone > Dynamic active-auction list',
      change: 'Inspect auction boundaries here. For server logs, open Systems Manager and run journalctl -u bc-marketplace.',
      reference: `Current cadence ${system.scheduler.tick_interval_ms / 1000}s`
    },
    {
      name: 'Bot engine',
      access: 'Admin Zone > Bot Command Center and Bot observatory',
      change: 'Create, configure, start, stop, and inspect bots here. Runtime evidence remains available in the observatory and reports.',
      reference: `${botSummary.registered} registered / ${botSummary.running} running`
    },
    {
      name: 'Evidence and reports',
      access: 'Admin Zone > Reports, Auction list history, and Audit and error inspection',
      change: 'Generate exports or inspect evidence here. Ledger and audit records are append-only and must not be manually rewritten.',
      reference: `${system.counts.events} events / ${system.counts.snapshots} snapshots`
    }
  ];

  return (
    <div className="market-page-data backend-admin-page">
      <div className="adminContainer">
        <Typography component="h1" variant="h4" gutterBottom style={{ textAlign: 'center' }}>
          Admin Zone
        </Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 680, mx: 'auto', mb: 3 }}>
          Manage users, budgets, auctions, automation, and reports.
        </Typography>

        <AdminCard title="Architecture & Operations" defaultOpen={true}>
          <div className="architectureIntro">
            <div>
              <strong>System map</strong>
              <span>Live operational view from the browser interface through the API and persistent database.</span>
            </div>
            <span className="architectureChecked">Checked {date(system.checked_at)}</span>
          </div>

          <div className="architectureFlow" aria-label="Project architecture flow">
            {[
              { icon: <CloudQueueOutlinedIcon />, label: 'Frontend', value: 'AWS Amplify', note: 'React + Vite' },
              { icon: <ApiOutlinedIcon />, label: 'API', value: 'AWS EC2', note: 'Node.js + systemd' },
              { icon: <StorageOutlinedIcon />, label: 'Data', value: 'SQLite', note: 'Persistent disk + WAL' },
              { icon: <ScheduleOutlinedIcon />, label: 'Automation', value: 'Scheduler', note: 'Auctions + bots' },
              { icon: <FactCheckOutlinedIcon />, label: 'Evidence', value: 'Reports', note: 'Ledger + snapshots' }
            ].map((layer, index) => (
              <div className="architectureLayer" key={layer.label}>
                <div className="architectureLayerIcon">{layer.icon}</div>
                <small>{layer.label}</small>
                <strong>{layer.value}</strong>
                <span>{layer.note}</span>
                {index < 4 && <i aria-hidden="true" />}
              </div>
            ))}
          </div>

          <div className="architectureComponentTable">
            <div className="architectureTableHeader">
              <span>Component</span><span>Responsibility</span><span>Runtime / location</span><span>Status</span>
            </div>
            {componentRows.map(component => (
              <div className="architectureComponentRow" key={component.name}>
                <a href={componentLinks[component.name]} target={componentLinks[component.name]?.startsWith('https:') ? '_blank' : undefined} rel="noreferrer">{component.name}</a>
                <span>{component.role}</span>
                <span>{component.host}<small>{component.detail}</small></span>
                <span className={`architectureStatus status-${component.status}`}>{component.status}</span>
              </div>
            ))}
          </div>

          <div className="architectureDetails">
            <section>
              <div className="architectureSectionTitle"><StorageOutlinedIcon fontSize="small" /><strong>Database and persistence</strong></div>
              <dl>
                <div><dt>Database file</dt><dd><code>{system.database.path}</code><br /><a href={resourceLinks.database} target="_blank" rel="noreferrer">Open database server session</a></dd></div>
                <div><dt>Storage mode</dt><dd>{system.database.journal_mode.toUpperCase()} / foreign keys {system.database.foreign_keys ? 'enabled' : 'disabled'}</dd></div>
                <div><dt>Database size</dt><dd>{formatBytes(system.database.size_bytes)}</dd></div>
                <div><dt>Latest backup</dt><dd>{system.database.latest_backup ? date(system.database.latest_backup.modified_at) : 'No filesystem backup recorded'}</dd></div>
              </dl>
              <div className="architectureCounts">
                {Object.entries(system.counts).map(([label, count]) => <span key={label}><strong>{count}</strong>{label.replaceAll('_', ' ')}</span>)}
              </div>
            </section>

            <section>
              <div className="architectureSectionTitle"><AccountTreeOutlinedIcon fontSize="small" /><strong>Deployment path</strong></div>
              <ol className="deploymentSteps">
                <li><strong>Source</strong><span>GitHub `master` and `codex/backend-marketplace-release` branches.</span></li>
                <li><strong>Verification</strong><span>Backend tests, browser E2E checks, and the Vite production build run before release.</span></li>
                <li><strong>Frontend</strong><span>The compiled static bundle is uploaded to AWS Amplify.</span></li>
                <li><strong>Backend</strong><span>EC2 pulls the release branch and restarts the `bc-marketplace` systemd service.</span></li>
                <li><strong>Data safety</strong><span>A consistent SQLite backup is created before backend migrations or restarts.</span></li>
              </ol>
            </section>
          </div>

          <div className="architectureAccess">
            <div className="architectureSectionTitle"><ApiOutlinedIcon fontSize="small" /><strong>How to access and maintain each component</strong></div>
            <p className="architectureAccessIntro">Use the Admin Zone for routine marketplace operations. Use AWS Systems Manager for server or database maintenance; no inbound SSH access is required.</p>
            <div className="architectureAccessGrid">
              {accessRows.map(component => (
                <section className="architectureAccessCard" key={component.name}>
                  <div className="architectureAccessHeading">
                    <a href={componentLinks[component.name]} target={componentLinks[component.name]?.startsWith('https:') ? '_blank' : undefined} rel="noreferrer">{component.name}</a>
                    <code>{component.reference}</code>
                  </div>
                  <dl>
                    <div><dt>Access</dt><dd>{component.access}</dd></div>
                    <div><dt>Change</dt><dd>{component.change}</dd></div>
                  </dl>
                  {component.warning && <div className="architectureMaintenanceWarning"><strong>Safe maintenance</strong><code>{component.warning}</code></div>}
                </section>
              ))}
            </div>
          </div>
        </AdminCard>

        <nav className="architectureResourceLinks" aria-label="Infrastructure resources">
          <a href={resourceLinks.frontend} target="_blank" rel="noreferrer">Amplify deployments</a>
          <a href={resourceLinks.server} target="_blank" rel="noreferrer">EC2 instance</a>
          <a href={resourceLinks.database} target="_blank" rel="noreferrer">Database, backups &amp; service logs</a>
          <a href={resourceLinks.source} target="_blank" rel="noreferrer">GitHub release source</a>
          <a href={resourceLinks.api} target="_blank" rel="noreferrer">API session endpoint</a>
        </nav>
        <p className="architectureAccessIntro">AWS links require your AWS account permissions. SQLite is a file on the EC2 server. The database link opens a server session. Run the backup command from /opt/bc-marketplace. For direct SQL maintenance, stop bc-marketplace, use a SQLite client with foreign keys enabled and a transaction, verify integrity, then restart the service. Preserve ledger and audit history.</p>
        <AdminCard title="Live Experiment Activity" defaultOpen={true}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 2 }}>
            {Object.entries(state.presence).map(([name, count]) => (
              <Box key={name} sx={{ p: 1.5, borderRadius: 2, background: 'rgba(255,255,255,0.7)', border: '1px solid #e2e7f2', textAlign: 'center' }}>
                <small style={{ color: '#5e638a', textTransform: 'capitalize' }}>
                  {name === 'auctions' ? 'Active auctions' : name}
                </small>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#002884' }}>{count}</div>
              </Box>
            ))}
          </Box>
        </AdminCard>

        <AdminCard title="Market manager">
          <form
            onSubmit={event => {
              event.preventDefault();
              const d = new FormData(event.currentTarget);
              act('/admin/settings', {
                name: d.get('name'),
                default_budget: Number(d.get('budget')),
                auto_finalize: true,
                allow_post_submit_edit: d.has('allowPostSubmitEdit')
              });
            }}
            style={{ display: 'grid', gap: '16px', maxWidth: '600px' }}
          >
            <TextField name="name" label="Market name" defaultValue={state.settings.name} required size="small" />
            <TextField name="budget" label="Default budget for new accounts" type="number" defaultValue={state.settings.default_budget} size="small" inputProps={{ min: 1, max: 1000000000 }} />
            <FormControlLabel
              control={<Checkbox name="allowPostSubmitEdit" defaultChecked={Boolean(state.settings.allow_post_submit_edit)} />}
              label="Allow sellers to edit the minimum bid before the first bid"
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
              Sellers can change only the minimum bid. The option disappears permanently after the first bid; admin database controls remain available.
            </Typography>
            <Button type="submit" variant="contained" style={{ backgroundColor: '#103090', borderRadius: '20px' }}>
              Save market settings
            </Button>
          </form>
        </AdminCard>

        <AdminCard title="Users and budgets" defaultOpen={true}>
          <form
            onSubmit={async event => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = Object.fromEntries(new FormData(form));
              if (await act('/admin/users', data)) form.reset();
            }}
            style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '1.5rem' }}
          >
            <TextField name="name" label="Name" required size="small" />
            <TextField name="identifier" label="Identifier" required size="small" />
            <TextField name="role" label="Role" select defaultValue="user" size="small" style={{ minWidth: '100px' }}>
              <MenuItem value="user">User</MenuItem>
              <MenuItem value="admin">Admin</MenuItem>
              <MenuItem value="bot">Bot</MenuItem>
            </TextField>
            <Button type="submit" variant="contained" startIcon={<AddIcon />} style={{ backgroundColor: '#103090', borderRadius: '20px' }}>
              Create account
            </Button>
          </form>

          <div className="tableScrollWrap">
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Name', 'Identifier', 'Role', 'Available budget', 'Account', 'Actions'].map((h, i) => (
                    <TableCell key={i} style={{ fontWeight: 700, color: '#002884' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {state.users.map(u => (
                  <TableRow key={u.id}>
                    <TableCell style={{ fontWeight: 600 }}>{u.name}</TableCell>
                    <TableCell>{u.identifier}</TableCell>
                    <TableCell>{u.role}</TableCell>
                    <TableCell style={{ fontWeight: 700 }}>{u.budget}</TableCell>
                    <TableCell>{u.disabled ? 'Disabled' : 'Enabled'}</TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        onClick={() => {
                          const total = window.prompt('Set total budget, including amounts reserved in winning bids:');
                          if (total !== null && total.trim()) act(`/admin/users/${u.id}/budget`, { total: Number(total) });
                        }}
                      >
                        Set budget
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          if (window.confirm(`${u.disabled ? 'Enable' : 'Disable'} ${u.name}?`)) {
                            act(`/admin/users/${u.id}/disabled`, { disabled: !u.disabled });
                          }
                        }}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </AdminCard>


        <AdminCard title="Set Global Budget">
          <form
            onSubmit={event => {
              event.preventDefault();
              const total = Number(new FormData(event.currentTarget).get('total'));
              if (window.confirm('Reset every account budget? Existing winning reservations will be deducted from the new total.')) {
                act('/admin/budgets/reset', { total });
              }
            }}
            style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}
          >
            <TextField
              name="total"
              label="Total budget per account"
              type="number"
              defaultValue={state.settings.default_budget}
              size="small"
              inputProps={{ min: 1, max: 1000000000 }}
            />
            <Button type="submit" variant="outlined" style={{ borderRadius: '20px' }}>
              Reset all budgets
            </Button>
          </form>
        </AdminCard>

        <div id="admin-bots" />
        <AdminCard title="Bot Command Center" defaultOpen={true}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' }, gap: 1, mb: 2 }}>
            <Box sx={{ p: 1.5, borderRadius: 2, background: '#fbfcff', border: '1px solid #e5e9f8' }}>
              <Typography variant="caption" color="text.secondary">Registered</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.1 }}>{botSummary.registered}</Typography>
            </Box>
            <Box sx={{ p: 1.5, borderRadius: 2, background: '#fbfcff', border: '1px solid #e5e9f8' }}>
              <Typography variant="caption" color="text.secondary">Running</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.1, color: '#217345' }}>{botSummary.running}</Typography>
            </Box>
            <Box sx={{ p: 1.5, borderRadius: 2, background: '#fbfcff', border: '1px solid #e5e9f8' }}>
              <Typography variant="caption" color="text.secondary">Cycles</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.1 }}>{botSummary.cycles}</Typography>
            </Box>
            <Box sx={{ p: 1.5, borderRadius: 2, background: '#fbfcff', border: '1px solid #e5e9f8' }}>
              <Typography variant="caption" color="text.secondary">Bids sent</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.1 }}>{botSummary.bids}</Typography>
            </Box>
          </Box>

          <form
            onSubmit={async event => {
              event.preventDefault();
              const form = event.currentTarget;
              if (await act('/admin/bots', { name: new FormData(form).get('name') })) form.reset();
            }}
            style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1.5rem' }}
          >
            <TextField name="name" label="Bot name" required size="small" />
            <Button type="submit" variant="contained" startIcon={<AddIcon />} style={{ backgroundColor: '#103090', borderRadius: '20px' }}>
              Add bot
            </Button>
          </form>

          <Box sx={{ display: 'flex', gap: '12px', flexWrap: 'wrap', mb: 2 }}>
            <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => setAdminReload(value => value + 1)} style={{ borderRadius: '20px' }}>
              Refresh
            </Button>
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => act('/admin/bots/start', {})} style={{ backgroundColor: '#2e7d32', borderRadius: '20px' }}>
              Start enabled
            </Button>
            <Button variant="outlined" onClick={() => act('/admin/bots/run', {})} style={{ borderRadius: '20px', borderColor: '#103090', color: '#103090' }}>
              Run manual cycle
            </Button>
            <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={() => act('/admin/bots/stop', {})} style={{ borderRadius: '20px' }}>
              Stop all
            </Button>
          </Box>

          {state.bots.map(bot => (
            <BotItem key={bot.user_id} bot={bot} act={act} />
          ))}
          {!state.bots.length && <p style={{ color: '#5e638a' }}>No bot accounts.</p>}

          <section className="backendBotObservatory">
            <details>
              <summary>
                <span>
                  <strong>Bot observatory</strong>
                  <small>Inspect coordinated assignments, bids, skips, and failures round by round.</small>
                </span>
                <span>{state.rounds.length} {state.rounds.length === 1 ? 'round' : 'rounds'}</span>
              </summary>
              <div className="backendBotRounds">
            {state.rounds.length > 0 ? (
              state.rounds.map(round => (
                <Box
                  key={round.id}
                  sx={{
                    mb: 1.5,
                    p: 1.5,
                    borderRadius: 2,
                    background: '#fbfcff',
                    border: '1px solid #e3e8f4',
                  }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700, color: '#002884' }}>
                      {date(round.created_at)}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', background: '#e8f5e9', color: '#2e7d32' }}>
                        {round.detail.sent || 0} bids sent
                      </span>
                      <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', background: '#eef2fb', color: '#103090' }}>
                        {round.detail.bots || 0} bots
                      </span>
                      <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', background: '#f5f5f5', color: '#555' }}>
                        {round.detail.duration || 0} ms
                      </span>
                    </Box>
                  </Box>

                  {round.detail.decisions?.length > 0 && (
                    <Box sx={{ display: 'grid', gap: 0.5, mb: 1 }}>
                      {round.detail.decisions.map((d, dIdx) => {
                        const botName = state.bots.find(b => b.user_id === d.bot)?.name || d.bot;
                        const isSent = d.outcome === 'sent';
                        const isFailed = d.outcome === 'failed';
                        return (
                          <Box
                            key={dIdx}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: '12px',
                              p: '4px 8px',
                              borderRadius: 1,
                              background: isSent ? '#f0f9f3' : isFailed ? '#fff5f5' : '#f8f9fa',
                            }}
                          >
                            <span>
                              <strong>{botName}</strong>
                              {d.auction && <span style={{ color: '#5e638a', marginLeft: '6px' }}>Auction {d.auction.slice(0, 8)}...</span>}
                            </span>
                            <span style={{ fontWeight: 600, color: isSent ? '#2e7d32' : isFailed ? '#c62828' : '#666' }}>
                              {isSent ? 'Bid placed' : isFailed ? `Failed: ${d.reason || 'error'}` : (d.reason || 'Skipped')}
                            </span>
                          </Box>
                        );
                      })}
                    </Box>
                  )}

                  <details style={{ marginTop: '6px' }}>
                    <summary style={{ cursor: 'pointer', color: '#5e638a', fontSize: '11px', fontWeight: 600 }}>
                      View cycle JSON detail
                    </summary>
                    <pre style={{ background: '#f0f3f9', padding: '10px', borderRadius: '6px', fontSize: '11px', marginTop: '6px', overflowX: 'auto' }}>
                      {JSON.stringify(round.detail, null, 2)}
                    </pre>
                  </details>
                </Box>
              ))
            ) : (
              <p style={{ color: '#5e638a', margin: 0, padding: '0.5rem 0' }}>
                No bot cycles recorded yet. Start bots or click "Run manual cycle" to observe automated bidding.
              </p>
            )}
              </div>
            </details>
          </section>
        </AdminCard>

        <AdminCard title="Batch Auction Studio">
          <BatchAuctionStudio act={act} notify={notify} />
        </AdminCard>

        <AdminCard title="Dynamic active-auction list">
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' }, gap: 1, mb: 2 }}>
            <Box sx={{ p: 1, borderRadius: 2, background: '#eaf8f1', border: '1px solid #b7e4c7', textAlign: 'center' }}>
              <small style={{ color: '#0f6d45', fontWeight: 700 }}>Active</small>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#168052' }}>
                {activeAuctionsCount}
              </div>
            </Box>
            <Box sx={{ p: 1, borderRadius: 2, background: '#f0f3f9', border: '1px solid #d9dff2', textAlign: 'center' }}>
              <small style={{ color: '#5e638a', fontWeight: 700 }}>Total listed</small>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#002884' }}>
                {auctions.length}
              </div>
            </Box>
          </Box>

          <div className="tableScrollWrap">
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Description', 'End date', 'Auction status', 'Highest bid', 'Bidders', 'Action'].map((h, i) => (
                    <TableCell key={i} align="center" style={{ fontWeight: 700, color: '#002884' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {auctions.filter(a => !a.finalized_at && a.end_at > Date.now()).map(a => {
                  const isActive = a.end_at > Date.now();
                  return (
                    <TableRow key={a.id}>
                      <TableCell align="center"><strong>{a.description}</strong><br /><small>{a.seller}</small></TableCell>
                      <TableCell align="center">{date(a.end_at)}</TableCell>
                      <TableCell align="center">
                        <Countdown end={a.end_at} />
                      </TableCell>
                      <TableCell align="center" style={{ fontWeight: 700 }}>{a.highest}</TableCell>
                      <TableCell align="center">{a.bidders}</TableCell>
                      <TableCell align="center">
                        <Button component={Link} to={`/auction/${a.id}`} size="small">View</Button>
                        {isActive && (
                          <IconAction title="Close auction early" onClick={() => window.confirm('Close auction early?') && act(`/admin/auctions/${a.id}/close`, {})}>
                            <StopIcon color="error" />
                          </IconAction>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </AdminCard>

        <AdminCard title="Auction list history">
          <form
            onSubmit={async event => {
              event.preventDefault();
              const time = new Date(new FormData(event.currentTarget).get('time')).getTime();
              try {
                setHistorical(await api(`/admin/list-state?at=${time}`));
              } catch (err) {
                notify(err.message);
              }
            }}
            style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}
          >
            <TextField name="time" label="State at" type="datetime-local" InputLabelProps={{ shrink: true }} required size="small" />
            <Button type="submit" variant="outlined" style={{ borderRadius: '20px' }}>Inspect state</Button>
          </form>
          {historical && (
            <div style={{ marginTop: '1rem' }}>
              <p style={{ color: '#002884', fontWeight: 600 }}>{date(historical.created_at)} / {historical.reason}</p>
              <div className="tableScrollWrap">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      {['Auction', 'Highest bid', 'End time'].map((h, i) => (
                        <TableCell key={i} align="center" style={{ fontWeight: 700, color: '#002884' }}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {historical.state.map(a => (
                      <TableRow key={a.id}>
                        <TableCell align="center">{a.description}</TableCell>
                        <TableCell align="center" style={{ fontWeight: 700 }}>{a.highest}</TableCell>
                        <TableCell align="center">{date(a.end_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </AdminCard>

        <div id="admin-reports" />
        <AdminCard title="Reports">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Build a focused export from auctions and ledger events. Choose optional date range, then download.
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5, mb: 1.5, maxWidth: '600px' }}>
            <TextField
              label="From end date"
              type="date"
              size="small"
              value={reportFromDate}
              onChange={e => setReportFromDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              disabled={reportIncludeAll}
            />
            <TextField
              label="To end date"
              type="date"
              size="small"
              value={reportToDate}
              onChange={e => setReportToDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              disabled={reportIncludeAll}
            />
          </Box>

          <FormControlLabel
            control={<Checkbox checked={reportIncludeAll} onChange={e => setReportIncludeAll(e.target.checked)} />}
            label="Export every auction (ignore date filter)"
            sx={{ mb: 2 }}
          />

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {['xls', 'json', 'csv', 'html'].map(kind => (
              <Button
                key={kind}
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={() => exportReport(kind).catch(err => notify(err.message))}
                style={{ borderRadius: '20px', borderColor: '#103090', color: '#103090', fontWeight: 600 }}
              >
                {kind === 'html' ? 'Printable report' : kind === 'xls' ? 'Workbook' : kind.toUpperCase()}
              </Button>
            ))}
          </div>
        </AdminCard>

        <AdminCard title="Audit and error inspection">
          <div className="tableScrollWrap">
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Time', 'Event', 'Actor', ''].map((h, i) => (
                    <TableCell key={i} align="center" style={{ fontWeight: 700, color: '#002884' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {state.events.map(e => (
                  <TableRow key={e.id}>
                    <TableCell align="center">{date(e.created_at)}</TableCell>
                    <TableCell align="center"><code>{e.type}</code></TableCell>
                    <TableCell align="center">{state.users.find(u => u.id === e.actor_id)?.name || e.actor_id}</TableCell>
                    <TableCell align="center">
                      <Button size="small" onClick={() => setInspect(JSON.stringify(e, null, 2))}>Inspect</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {inspect && (
            <pre style={{ background: '#f0f3f9', padding: '12px', borderRadius: '8px', marginTop: '1rem', overflow: 'auto' }}>
              {inspect}
            </pre>
          )}
        </AdminCard>
      </div>
    </div>
  );
}

function AccountView({ user }) {
  return (
    <div className="market-page-data">
      <div className="campaignInfo" style={{ margin: '2rem auto', width: 'min(500px, 100%)' }}>
        <h1 className="introductionTitle" style={{ textAlign: 'center' }}>Account Profile</h1>
        <hr style={{ border: 0, borderTop: '1px solid rgba(16, 48, 144, 0.12)', margin: '1rem 0 1.5rem' }} />
        <div className="introductionDetail">
          <span className="introductionLabel">Name: </span>
          <span className="introductionText">{user.name}</span>
        </div>
        <div className="introductionDetail">
          <span className="introductionLabel">Identifier: </span>
          <span className="introductionText">{user.identifier}</span>
        </div>
        <div className="introductionDetail">
          <span className="introductionLabel">Role: </span>
          <span className="introductionText" style={{ textTransform: 'capitalize' }}>{user.role}</span>
        </div>
        <div className="introductionDetail">
          <span className="introductionLabel">Budget: </span>
          <span className="introductionText" style={{ fontWeight: 700 }}>{user.budget}</span>
        </div>
      </div>
    </div>
  );
}

export default function BackendApp() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [auctions, setAuctions] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [revision, setRevision] = useState(0);

  const navigate = useNavigate();
  const location = useLocation();
  const inFlight = useRef(false);

  const notify = useCallback(text => setMessage(text), []);

  const refresh = useCallback(async () => {
    if (inFlight.current || document.hidden) return;
    inFlight.current = true;
    try {
      const val = await api('/session');
      setSession(val);
      synchronizeMarketClock(val.serverTime);
      const list = await api('/auctions');
      setAuctions(list.auctions);
    } catch (err) {
      if (err.status === 401) setSession(null);
      else notify(err.message);
    } finally {
      inFlight.current = false;
      setReady(true);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    const visible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!session?.user?.id) return;
    const beat = () => { if (!document.hidden) api('/heartbeat', {}).catch(() => {}); };
    beat();
    const timer = setInterval(beat, 15000);
    return () => clearInterval(timer);
  }, [session?.user?.id]);

  useEffect(() => {
    document.title = 'Data Marketplace | Research Data Auctions';
  }, []);

  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  const act = async (path, body, headers) => {
    if (busy) return null;
    setBusy(true);
    setMessage('');
    try {
      const result = await api(path, body, headers);
      setRevision(v => v + 1);
      try { await refresh(); } catch { /* Confirmed writes remain successful; polling retries the refresh. */ }
      return result || { ok: true };
    } catch (err) {
      notify(err.message);
      if (err.status === 401) setSession(null);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    await act('/logout', {});
    setSession(null);
    navigate('/login');
  };

  if (!ready) {
    return (
      <div className="market-app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <p role="status" style={{ fontSize: '1.25rem', color: '#002884', fontWeight: 600 }}>
          Connecting to marketplace...
        </p>
      </div>
    );
  }

  const user = session?.user;
  const admin = user?.role === 'admin';

  return (
    <div className="market-app">
      <AppBar position="static">
        <Toolbar className={`${shellStyles.appToolbar} backend-toolbar`}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <Button
              variant="text"
              className={shellStyles.toolbarIconButton}
              onClick={() => setDrawer(true)}
              aria-label="Open menu"
              title="Open menu"
            >
              <MenuIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Button
              variant="text"
              className={shellStyles.toolbarIconButton}
              onClick={() => navigate('/auctions-list')}
              aria-label="Open auctions list"
              title="Open auctions list"
            >
              <HomeIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Typography
              component="div"
              className={`${shellStyles.bigTitle} ${shellStyles.toolbarTitle}`}
              onClick={() => navigate('/auctions-list')}
              style={{ cursor: 'pointer' }}
            >
              Data Marketplace
            </Typography>
          </div>

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginRight: '1rem' }}>
            <div
              className={`${shellStyles.toolbarPill} ${shellStyles.environmentPill} ${shellStyles.environmentPillLive}`}
              title="Live environment"
              aria-label="Live environment"
            >
              <span className={shellStyles.environmentLiveDot} aria-hidden="true" />
              <SensorsOutlinedIcon className={shellStyles.toolbarPillIcon} fontSize="small" aria-hidden="true" />
              <span className={shellStyles.toolbarPillValue}>Live</span>
            </div>

            <div className={shellStyles.toolbarPill} title="Current budget">
              <TollOutlinedIcon className={shellStyles.toolbarPillIcon} fontSize="small" aria-hidden="true" />
              <span className={shellStyles.toolbarPillLabel}>Budget:</span>
              <span className={shellStyles.toolbarPillValue}>{user?.budget ?? '2000'}</span>
            </div>

            <ClockDisplay />

            {user && (
              <Button
                variant="text"
                aria-label="Sign out"
                title="Sign out"
                className={shellStyles.toolbarIconButton}
                onClick={handleLogout}
                style={{
                  color: '#F0B030',
                  textTransform: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '0 8px',
                  height: '2.5rem',
                }}
              >
                <LogoutIcon htmlColor="#F0B030" fontSize="medium" />
                <span style={{ fontSize: '0.85rem', color: '#f0f0f0', whiteSpace: 'nowrap' }}>Sign out</span>
              </Button>
            )}
          </div>
        </Toolbar>
      </AppBar>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        PaperProps={{ className: 'market-drawer-paper' }}
      >
        <div className="market-drawer-list" role="presentation" onClick={() => setDrawer(false)}>
          <div className="market-drawer-nav-group">
            <ListItemButton
              component={Link}
              to="/"
              className={`market-drawer-item ${location.pathname === '/' || location.pathname === '/home' ? 'market-drawer-item-active' : ''}`}
            >
              <span className="market-drawer-icon-tile">
                <img src={homeIcon} className="market-drawer-icon-img" alt="" />
              </span>
              <ListItemText primary="Back to Login" />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/auctions-list"
              className={`market-drawer-item ${location.pathname === '/auctions-list' ? 'market-drawer-item-active' : ''}`}
            >
              <span className="market-drawer-icon-tile">
                <img src={bidIcon} className="market-drawer-icon-img" alt="" />
              </span>
              <ListItemText primary="View Auctions" />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/open-auction"
              className={`market-drawer-item ${location.pathname === '/open-auction' ? 'market-drawer-item-active' : ''}`}
              aria-label="Start an Auction"
            >
              <span className="market-drawer-icon-tile">
                <img src={campaignIcon} className="market-drawer-icon-img" alt="" />
              </span>
              <ListItemText primary="Start An Auction" />
            </ListItemButton>

            {user && (
              <ListItemButton
                component={Link}
                to="/account"
                className={`market-drawer-item ${location.pathname === '/account' ? 'market-drawer-item-active' : ''}`}
              >
                <span className="market-drawer-icon-tile">
                  <img src={metaIcon} className="market-drawer-icon-img" alt="" />
                </span>
                <ListItemText primary="Account Profile" />
              </ListItemButton>
            )}

            <ListItemButton
              component={Link}
              to="/guide"
              className={`market-drawer-item ${location.pathname === '/guide' ? 'market-drawer-item-active' : ''}`}
            >
              <span className="market-drawer-icon-tile">
                <img src={metaIcon} className="market-drawer-icon-img" alt="" />
              </span>
              <ListItemText primary="Platform Guide" />
            </ListItemButton>
          </div>

          {admin && (
            <div className="market-drawer-admin-section">
              <ListItemButton
                component={Link}
                to="/manage-budget"
                className={`market-drawer-item market-drawer-admin-item ${location.pathname === '/manage-budget' ? 'market-drawer-item-active' : ''}`}
                dense
              >
                <ListItemText primary="-- Admin Zone --" />
              </ListItemButton>
            </div>
          )}
        </div>
      </Drawer>

      {message && (
        <div role="alert" style={{ margin: '12px auto', width: 'min(900px, 92%)', background: '#ffebee', color: '#c62828', padding: '10px 16px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{message}</span>
          <IconButton size="small" onClick={() => setMessage('')}><CloseIcon fontSize="small" /></IconButton>
        </div>
      )}

      <main aria-busy={busy} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={<HomePageView user={user} />} />
          <Route path="/home" element={<HomePageView user={user} />} />
          <Route path="/login" element={user ? <Navigate to="/auctions-list" replace /> : <Login onLogin={val => { setSession(val); refresh(); }} />} />
          <Route path="/guide" element={<PlatformGuideView />} />
          <Route path="/platform-guide" element={<PlatformGuideView />} />
          <Route path="/account" element={user ? <AccountView user={user} /> : <Login onLogin={val => { setSession(val); refresh(); }} />} />
          <Route path="/auctions-list" element={user ? <AuctionsListView auctions={auctions} user={user} admin={admin} act={act} refresh={refresh} allowPostSubmitEdit={Boolean(session.settings?.allow_post_submit_edit)} /> : <Login onLogin={val => { setSession(val); refresh(); }} />} />
          <Route path="/open-auction" element={user ? <NewAuctionView act={act} /> : <Login onLogin={val => { setSession(val); refresh(); }} />} />
          <Route path="/auction/:address" element={user ? <AuctionDetailsView key={location.pathname} user={user} act={act} revision={revision} allowPostSubmitEdit={Boolean(session.settings?.allow_post_submit_edit)} canExportTransactions={Boolean(admin && session.adminAccess)} /> : <Login onLogin={val => { setSession(val); refresh(); }} />} />
          <Route path="/manage-budget" element={!user ? <Login onLogin={val => { setSession(val); refresh(); }} /> : admin ? <AdminView auctions={auctions} act={act} revision={revision} notify={notify} /> : <Navigate to="/auctions-list" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
