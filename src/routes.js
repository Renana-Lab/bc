// import {  Router, Switch, Route,  } from "react-router-dom";
// import HomePage from "./App.js";
// import NewAuctionPage from "./pages/NewAuction/NewAuctionPage";
// import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage";
// import MetamaskTutorialPage from "./pages/Metamask/MetamaskTutorialPage";
// import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage";

// export default function Routes() {
//   return (
//     <Router>    <Switch>
//         <Route path="/"><HomePage /></Route>
//         <Route path="open-auction"><NewAuctionPage/></Route>
// {/* 

//       <Route exact path="/" component={HomePage} >
//       <Route exact path="/open-auction" component={NewAuctionPage} ></Route>
//       <Route exact path="/auctions-list" component={AuctionsListPage} ></Route>
//       <Route exact path="/metamask-tutorial" component={MetamaskTutorialPage} ></Route>
//       <Route exact path="/auction/:address" component={ShowAuctionPage} /></Route> */}
//     </Switch></Router>

//   );
// }
import React from 'react';
// import { Route, Routes } from 'react-router-dom';
import { BrowserRouter as Router, Route,Routes, Switch } from 'react-router-dom';

import HomePage from "./pages/Home/HomePage";
import NewAuctionPage from "./pages/NewAuction/NewAuctionPage";
import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage";
import MetamaskTutorialPage from "./pages/Metamask/MetamaskTutorialPage";
import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage";
function Routes1() {
    return (
        <Router>
            <Routes>
        <Route  path='/' element={<HomePage/>} />
        <Route  path='/open-auction' element={<NewAuctionPage/>} />
        <Route  path='/auctions-list' element={<AuctionsListPage/>} />
        <Route  path='/metamask-tutorial' element={<MetamaskTutorialPage/>} />
        <Route  path='/auction/:address' element={<ShowAuctionPage/>} />
      </Routes></Router>
//     <BrowserRouter>
//   <Routes>
//     {/* <Route exact path="/" component={Home} /> */}
//     <Route  path='/' element={HomePage} />
//     <Route  path='/open-auction' element={NewAuctionPage} />
//     <Route  path='/auctions-list' component={AuctionsListPage} />
//     <Route  path='/metamask-tutorial' component={MetamaskTutorialPage} />
//     <Route  path='/auction/:address' component={ShowAuctionPage} />
//   </Routes>
// </BrowserRouter>

    );

  }
export default Routes1;


