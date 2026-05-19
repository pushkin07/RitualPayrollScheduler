// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PayrollScheduler {
    enum Frequency {
        OneTime,
        Daily,
        Weekly,
        Monthly
    }

    struct Recipient {
        address wallet;
        string label;
        uint256 amount;
        uint8 frequency;
        uint256 nextPaymentTime;
        bool active;
        uint256 paidCount;
        bool removed;
    }

    struct PaymentHistory {
        uint256 recipientId;
        address wallet;
        string label;
        uint256 amount;
        uint256 timestamp;
    }

    error OnlyOwner();
    error InvalidWallet();
    error InvalidAmount();
    error InvalidFrequency();
    error InvalidRecipient();
    error RecipientAlreadyRemoved();
    error RecipientInactive();
    error NoDuePayments();
    error InsufficientPayrollBalance(uint256 requiredAmount, uint256 availableAmount);
    error InsufficientKeeperFeeBalance(uint256 requiredAmount, uint256 availableAmount);
    error TransferFailed();

    address public immutable owner;
    string public payrollName;
    uint256 public payrollReserved;
    uint256 public keeperFeeReserved;
    uint256 public keeperRewardAmount;

    Recipient[] private recipients;
    PaymentHistory[] private paymentHistory;

    event PayrollFunded(address indexed from, uint256 amount);
    event KeeperFeesFunded(address indexed from, uint256 amount);
    event KeeperRewardAmountUpdated(uint256 amount);
    event KeeperRewardPaid(address indexed keeper, uint256 amount);
    event KeeperRewardSkipped(address indexed keeper, uint256 requested, uint256 available);
    event PayrollFundsWithdrawn(address indexed to, uint256 amount);
    event KeeperFeesWithdrawn(address indexed to, uint256 amount);
    event RecipientAdded(
        uint256 indexed recipientId,
        address indexed wallet,
        string label,
        uint256 amount,
        uint8 frequency,
        uint256 startTime
    );
    event RecipientPaused(uint256 indexed recipientId);
    event RecipientResumed(uint256 indexed recipientId);
    event RecipientRemoved(uint256 indexed recipientId);
    event PaymentExecuted(uint256 indexed recipientId, address indexed wallet, uint256 amount, uint256 timestamp);
    event RemainingWithdrawn(address indexed owner, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(string memory _payrollName) {
        owner = msg.sender;
        payrollName = _payrollName;
    }

    receive() external payable {
        payrollReserved += msg.value;
        emit PayrollFunded(msg.sender, msg.value);
    }

    function fundPayroll() external payable {
        payrollReserved += msg.value;
        emit PayrollFunded(msg.sender, msg.value);
    }

    function fundKeeperFees() external payable {
        keeperFeeReserved += msg.value;
        emit KeeperFeesFunded(msg.sender, msg.value);
    }

    function setKeeperRewardAmount(uint256 newAmount) external onlyOwner {
        keeperRewardAmount = newAmount;
        emit KeeperRewardAmountUpdated(newAmount);
    }

    function addRecipient(
        address wallet,
        string calldata label,
        uint256 amount,
        uint8 frequency,
        uint256 startTime
    ) external onlyOwner {
        if (wallet == address(0)) revert InvalidWallet();
        if (amount == 0) revert InvalidAmount();
        if (frequency > uint8(Frequency.Monthly)) revert InvalidFrequency();

        recipients.push(
            Recipient({
                wallet: wallet,
                label: label,
                amount: amount,
                frequency: frequency,
                nextPaymentTime: startTime,
                active: true,
                paidCount: 0,
                removed: false
            })
        );

        emit RecipientAdded(recipients.length - 1, wallet, label, amount, frequency, startTime);
    }

    function executeDuePayments() external {
        uint256[] memory dueRecipientIds = new uint256[](recipients.length);
        uint256 dueCount;
        uint256 totalDue;
        uint256 currentTime = _currentTime();

        for (uint256 i = 0; i < recipients.length; i++) {
            Recipient storage recipient = recipients[i];
            if (_isDue(recipient, currentTime)) {
                dueRecipientIds[dueCount] = i;
                dueCount++;
                totalDue += recipient.amount;
            }
        }

        if (dueCount == 0) revert NoDuePayments();
        if (payrollReserved < totalDue) {
            revert InsufficientPayrollBalance(totalDue, payrollReserved);
        }

        payrollReserved -= totalDue;
        uint256 rewardAmount = keeperRewardAmount;
        bool payKeeperReward = rewardAmount > 0 && keeperFeeReserved >= rewardAmount;

        if (payKeeperReward) {
            keeperFeeReserved -= rewardAmount;
            emit KeeperRewardPaid(msg.sender, rewardAmount);
        } else if (rewardAmount > 0) {
            emit KeeperRewardSkipped(msg.sender, rewardAmount, keeperFeeReserved);
        }

        for (uint256 i = 0; i < dueCount; i++) {
            uint256 recipientId = dueRecipientIds[i];
            Recipient storage recipient = recipients[recipientId];
            uint256 amount = recipient.amount;
            address wallet = recipient.wallet;
            string memory label = recipient.label;

            recipient.paidCount += 1;
            if (recipient.frequency == uint8(Frequency.OneTime)) {
                recipient.active = false;
            } else {
                recipient.nextPaymentTime += _frequencyInterval(recipient.frequency);
            }

            paymentHistory.push(
                PaymentHistory({
                    recipientId: recipientId,
                    wallet: wallet,
                    label: label,
                    amount: amount,
                    timestamp: currentTime
                })
            );

            emit PaymentExecuted(recipientId, wallet, amount, currentTime);

            (bool success,) = wallet.call{value: amount}("");
            if (!success) revert TransferFailed();
        }

        if (payKeeperReward) {
            (bool rewardSuccess,) = msg.sender.call{value: rewardAmount}("");
            if (!rewardSuccess) revert TransferFailed();
        }
    }

    function pauseRecipient(uint256 recipientId) external onlyOwner {
        Recipient storage recipient = _recipientAt(recipientId);
        if (recipient.removed) revert RecipientAlreadyRemoved();
        recipient.active = false;
        emit RecipientPaused(recipientId);
    }

    function resumeRecipient(uint256 recipientId) external onlyOwner {
        Recipient storage recipient = _recipientAt(recipientId);
        if (recipient.removed) revert RecipientAlreadyRemoved();
        recipient.active = true;
        emit RecipientResumed(recipientId);
    }

    function removeRecipient(uint256 recipientId) external onlyOwner {
        Recipient storage recipient = _recipientAt(recipientId);
        if (recipient.removed) revert RecipientAlreadyRemoved();
        recipient.active = false;
        recipient.removed = true;
        emit RecipientRemoved(recipientId);
    }

    function withdrawRemaining(uint256 amount) external onlyOwner {
        withdrawPayrollFunds(amount);
    }

    function withdrawPayrollFunds(uint256 amount) public onlyOwner {
        if (amount == 0) revert InvalidAmount();
        if (payrollReserved < amount) {
            revert InsufficientPayrollBalance(amount, payrollReserved);
        }

        payrollReserved -= amount;
        emit PayrollFundsWithdrawn(owner, amount);
        emit RemainingWithdrawn(owner, amount);

        (bool success,) = owner.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function withdrawKeeperFees(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        if (keeperFeeReserved < amount) {
            revert InsufficientKeeperFeeBalance(amount, keeperFeeReserved);
        }

        keeperFeeReserved -= amount;
        emit KeeperFeesWithdrawn(owner, amount);

        (bool success,) = owner.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function getRecipients() external view returns (Recipient[] memory) {
        return recipients;
    }

    function getPaymentHistory() external view returns (PaymentHistory[] memory) {
        return paymentHistory;
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getAccounting()
        external
        view
        returns (
            uint256 payrollReserved_,
            uint256 keeperFeeReserved_,
            uint256 keeperRewardAmount_,
            uint256 contractBalance
        )
    {
        return (payrollReserved, keeperFeeReserved, keeperRewardAmount, address(this).balance);
    }

    function _recipientAt(uint256 recipientId) private view returns (Recipient storage recipient) {
        if (recipientId >= recipients.length) revert InvalidRecipient();
        recipient = recipients[recipientId];
    }

    function _isDue(Recipient storage recipient, uint256 currentTime) private view returns (bool) {
        return !recipient.removed && recipient.active && recipient.nextPaymentTime <= currentTime;
    }

    function _currentTime() private view returns (uint256) {
        if (block.timestamp > 10_000_000_000) {
            return block.timestamp / 1000;
        }
        return block.timestamp;
    }

    function _frequencyInterval(uint8 frequency) private pure returns (uint256) {
        if (frequency == uint8(Frequency.Daily)) return 1 days;
        if (frequency == uint8(Frequency.Weekly)) return 7 days;
        if (frequency == uint8(Frequency.Monthly)) return 30 days;
        revert InvalidFrequency();
    }
}
