import React from 'react';
import { Routes , Route , Link, matchPath, Navigate, useNavigate } from 'react-router-dom';
import HomePage from "./pages/Home/HomePage.js";
import NewAuctionPage from "./pages/NewAuction/NewAuctionPage.js";
import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage.js";
import MetamaskTutorialPage from "./pages/Metamask/MetamaskTutorialPage.js";
import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage.js";
// import Routes from './routes';

class App extends React.Component{
  componentDidMount(){
    setTimeout(
      ()=>{
        this.props.navigate("/")
      },5000
    )
  }
  render(){
    return(
      <div>
                <div>
            <Routes>
        <Route  path='/' element={<HomePage/>} />
        <Route  path='/open-auction' element={<NewAuctionPage/>} />
        <Route  path='/auctions-list' element={<AuctionsListPage/>} />
        <Route  path='/metamask-tutorial' element={<MetamaskTutorialPage/>} />
        <Route  path='/auction/:address' element={<ShowAuctionPage/>} />
      </Routes></div>
      </div>
    )
  }
}

// } (
//   <BrowserRouter>
//     <Routes />
//   </BrowserRouter>
// );
export function APPWithRouter(props){
  const navigate = useNavigate();
  return (<App navigate={navigate}></App>)
}
export default App;