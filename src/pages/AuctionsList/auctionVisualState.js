const normalizeAddress = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const preserveAuctionUserState = (
  currentAuctions,
  nextAuctions,
  userAddress,
) => {
  const normalizedUserAddress = normalizeAddress(userAddress);
  if (!normalizedUserAddress || !currentAuctions?.length) {
    return nextAuctions || [];
  }

  const currentByAddress = new Map(
    currentAuctions.map((auction) => [
      normalizeAddress(auction.address),
      auction,
    ]),
  );

  return (nextAuctions || []).map((nextAuction) => {
    const currentAuction = currentByAddress.get(
      normalizeAddress(nextAuction.address),
    );
    const nextStatusIsFresh =
      nextAuction.hasUserStatus &&
      normalizeAddress(nextAuction.userStatusAddress) === normalizedUserAddress;
    const currentStatusMatchesUser =
      currentAuction?.hasUserStatus &&
      normalizeAddress(currentAuction.userStatusAddress) ===
        normalizedUserAddress;

    if (!currentStatusMatchesUser || nextStatusIsFresh) {
      return nextAuction;
    }

    return {
      ...nextAuction,
      addresses: currentAuction.addresses || [],
      isRefunded: Boolean(currentAuction.isRefunded),
      hasUserStatus: true,
      userStatusAddress: normalizedUserAddress,
    };
  });
};
