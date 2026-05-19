// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PayrollScheduler} from "../src/PayrollScheduler.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
    function deal(address account, uint256 newBalance) external;
}

contract PayrollActor {
    function addRecipient(
        PayrollScheduler scheduler,
        address wallet,
        string calldata label,
        uint256 amount,
        uint8 frequency,
        uint256 startTime
    ) external {
        scheduler.addRecipient(wallet, label, amount, frequency, startTime);
    }

    function withdrawRemaining(PayrollScheduler scheduler, uint256 amount) external {
        scheduler.withdrawRemaining(amount);
    }

    function withdrawPayrollFunds(PayrollScheduler scheduler, uint256 amount) external {
        scheduler.withdrawPayrollFunds(amount);
    }

    function withdrawKeeperFees(PayrollScheduler scheduler, uint256 amount) external {
        scheduler.withdrawKeeperFees(amount);
    }

    function setKeeperRewardAmount(PayrollScheduler scheduler, uint256 amount) external {
        scheduler.setKeeperRewardAmount(amount);
    }

    function executeDuePayments(PayrollScheduler scheduler) external {
        scheduler.executeDuePayments();
    }

    receive() external payable {}
}

contract RejectingRecipient {
    receive() external payable {
        revert("reject");
    }
}

contract PayrollSchedulerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PayrollScheduler private scheduler;
    PayrollActor private actor;
    address payable private recipient = payable(address(0xBEEF));

    receive() external payable {}

    function setUp() public {
        scheduler = new PayrollScheduler("Core Contributors");
        actor = new PayrollActor();
        vm.deal(address(this), 100 ether);
        vm.deal(recipient, 0);
        vm.warp(1_000);
    }

    function test_constructorSetsOwnerAndName() public {
        assertEqAddress(scheduler.owner(), address(this));
        assertEqString(scheduler.payrollName(), "Core Contributors");
    }

    function test_ownerCanAddRecipient() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);

        PayrollScheduler.Recipient[] memory recipients = scheduler.getRecipients();
        assertEqUint(recipients.length, 1);
        assertEqAddress(recipients[0].wallet, recipient);
        assertEqString(recipients[0].label, "Alice");
        assertEqUint(recipients[0].amount, 1 ether);
        assertEqUint(recipients[0].frequency, 0);
        assertTrue(recipients[0].active);
        assertFalse(recipients[0].removed);
    }

    function test_nonOwnerCannotAddRecipient() public {
        try actor.addRecipient(scheduler, recipient, "Alice", 1 ether, 0, block.timestamp) {
            fail("non-owner add should revert");
        } catch {}
    }

    function test_fundPayrollIncreasesBalance() public {
        scheduler.fundPayroll{value: 2 ether}();

        assertEqUint(address(scheduler).balance, 2 ether);
        assertEqUint(scheduler.payrollReserved(), 2 ether);
        assertEqUint(scheduler.getContractBalance(), 2 ether);
    }

    function test_fundKeeperFeesIncreasesKeeperFeeReserved() public {
        scheduler.fundKeeperFees{value: 0.2 ether}();

        assertEqUint(address(scheduler).balance, 0.2 ether);
        assertEqUint(scheduler.keeperFeeReserved(), 0.2 ether);
    }

    function test_ownerCanSetKeeperReward() public {
        scheduler.setKeeperRewardAmount(0.01 ether);

        assertEqUint(scheduler.keeperRewardAmount(), 0.01 ether);
    }

    function test_nonOwnerCannotSetKeeperReward() public {
        try actor.setKeeperRewardAmount(scheduler, 0.01 ether) {
            fail("non-owner set reward should revert");
        } catch {}
    }

    function test_executeDuePaymentsPaysDueOneTimeRecipient() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();

        uint256 beforeBalance = recipient.balance;
        scheduler.executeDuePayments();

        assertEqUint(recipient.balance, beforeBalance + 1 ether);
        assertEqUint(scheduler.payrollReserved(), 0);

        PayrollScheduler.PaymentHistory[] memory history = scheduler.getPaymentHistory();
        assertEqUint(history.length, 1);
        assertEqUint(history[0].recipientId, 0);
        assertEqAddress(history[0].wallet, recipient);
        assertEqString(history[0].label, "Alice");
        assertEqUint(history[0].amount, 1 ether);
        assertEqUint(history[0].timestamp, block.timestamp);
    }

    function test_oneTimeRecipientBecomesInactiveAfterPayment() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();

        scheduler.executeDuePayments();

        PayrollScheduler.Recipient[] memory recipients = scheduler.getRecipients();
        assertFalse(recipients[0].active);
        assertEqUint(recipients[0].paidCount, 1);
    }

    function test_recurringRecipientGetsNextPaymentTimeAdvanced() public {
        uint256 startTime = block.timestamp;
        scheduler.addRecipient(recipient, "Alice", 1 ether, 1, startTime);
        scheduler.fundPayroll{value: 2 ether}();

        scheduler.executeDuePayments();

        PayrollScheduler.Recipient[] memory recipients = scheduler.getRecipients();
        assertTrue(recipients[0].active);
        assertEqUint(recipients[0].nextPaymentTime, startTime + 1 days);
        assertEqUint(recipients[0].paidCount, 1);
    }

    function test_executeDuePaymentsPaysRecipientAndKeeperRewardWhenFeePoolHasEnoughBalance() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();
        scheduler.fundKeeperFees{value: 0.05 ether}();
        scheduler.setKeeperRewardAmount(0.01 ether);

        uint256 recipientBefore = recipient.balance;
        uint256 keeperBefore = address(actor).balance;

        actor.executeDuePayments(scheduler);

        assertEqUint(recipient.balance, recipientBefore + 1 ether);
        assertEqUint(address(actor).balance, keeperBefore + 0.01 ether);
        assertEqUint(scheduler.payrollReserved(), 0);
        assertEqUint(scheduler.keeperFeeReserved(), 0.04 ether);
        assertEqUint(address(scheduler).balance, 0.04 ether);
    }

    function test_executeDuePaymentsPaysRecipientButSkipsRewardWhenFeePoolIsEmpty() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();
        scheduler.setKeeperRewardAmount(0.01 ether);

        uint256 recipientBefore = recipient.balance;
        uint256 keeperBefore = address(actor).balance;

        actor.executeDuePayments(scheduler);

        assertEqUint(recipient.balance, recipientBefore + 1 ether);
        assertEqUint(address(actor).balance, keeperBefore);
        assertEqUint(scheduler.payrollReserved(), 0);
        assertEqUint(scheduler.keeperFeeReserved(), 0);
    }

    function test_executeDuePaymentsDoesNotPayKeeperRewardWhenNoPaymentsAreDue() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp + 1 days);
        scheduler.fundPayroll{value: 1 ether}();
        scheduler.fundKeeperFees{value: 0.05 ether}();
        scheduler.setKeeperRewardAmount(0.01 ether);

        uint256 keeperBefore = address(actor).balance;

        try actor.executeDuePayments(scheduler) {
            fail("execute with no due payments should revert");
        } catch {}

        assertEqUint(address(actor).balance, keeperBefore);
        assertEqUint(scheduler.keeperFeeReserved(), 0.05 ether);
    }

    function test_cannotExecuteBeforeDueTime() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp + 1 days);
        scheduler.fundPayroll{value: 1 ether}();

        try scheduler.executeDuePayments() {
            fail("execute before due should revert");
        } catch {}
    }

    function test_cannotExecuteIfInsufficientBalance() public {
        scheduler.addRecipient(recipient, "Alice", 2 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();

        try scheduler.executeDuePayments() {
            fail("insufficient balance should revert");
        } catch {}
    }

    function test_ownerCanPauseResumeRecipient() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);

        scheduler.pauseRecipient(0);
        PayrollScheduler.Recipient[] memory recipients = scheduler.getRecipients();
        assertFalse(recipients[0].active);

        scheduler.resumeRecipient(0);
        recipients = scheduler.getRecipients();
        assertTrue(recipients[0].active);
    }

    function test_pausedRecipientIsNotPaid() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();
        scheduler.pauseRecipient(0);

        uint256 beforeBalance = recipient.balance;
        try scheduler.executeDuePayments() {
            fail("paused recipient should not be due");
        } catch {}

        assertEqUint(recipient.balance, beforeBalance);
        assertEqUint(scheduler.getPaymentHistory().length, 0);
    }

    function test_ownerCanWithdrawRemainingFunds() public {
        scheduler.fundPayroll{value: 2 ether}();

        uint256 beforeBalance = address(this).balance;
        scheduler.withdrawRemaining(1 ether);

        assertEqUint(address(this).balance, beforeBalance + 1 ether);
        assertEqUint(address(scheduler).balance, 1 ether);
        assertEqUint(scheduler.payrollReserved(), 1 ether);
    }

    function test_ownerCanWithdrawPayrollFunds() public {
        scheduler.fundPayroll{value: 2 ether}();

        uint256 beforeBalance = address(this).balance;
        scheduler.withdrawPayrollFunds(1 ether);

        assertEqUint(address(this).balance, beforeBalance + 1 ether);
        assertEqUint(scheduler.payrollReserved(), 1 ether);
    }

    function test_ownerCanWithdrawKeeperFees() public {
        scheduler.fundKeeperFees{value: 0.2 ether}();

        uint256 beforeBalance = address(this).balance;
        scheduler.withdrawKeeperFees(0.1 ether);

        assertEqUint(address(this).balance, beforeBalance + 0.1 ether);
        assertEqUint(scheduler.keeperFeeReserved(), 0.1 ether);
    }

    function test_nonOwnerCannotWithdraw() public {
        scheduler.fundPayroll{value: 2 ether}();

        try actor.withdrawRemaining(scheduler, 1 ether) {
            fail("non-owner withdraw should revert");
        } catch {}
    }

    function test_keeperCannotWithdrawFunds() public {
        scheduler.fundPayroll{value: 2 ether}();
        scheduler.fundKeeperFees{value: 0.2 ether}();

        try actor.withdrawPayrollFunds(scheduler, 1 ether) {
            fail("keeper withdraw payroll should revert");
        } catch {}

        try actor.withdrawKeeperFees(scheduler, 0.1 ether) {
            fail("keeper withdraw fees should revert");
        } catch {}
    }

    function test_removedRecipientIsNotPaid() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 1 ether}();
        scheduler.removeRecipient(0);

        try scheduler.executeDuePayments() {
            fail("removed recipient should not be due");
        } catch {}

        assertEqUint(recipient.balance, 0);
    }

    function test_monthlyFrequencyAdvancesByThirtyDays() public {
        uint256 startTime = block.timestamp;
        scheduler.addRecipient(recipient, "Alice", 1 ether, 3, startTime);
        scheduler.fundPayroll{value: 1 ether}();

        scheduler.executeDuePayments();

        PayrollScheduler.Recipient[] memory recipients = scheduler.getRecipients();
        assertEqUint(recipients[0].nextPaymentTime, startTime + 30 days);
    }

    function test_accountingValuesAreCorrectAfterPaymentAndKeeperReward() public {
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, block.timestamp);
        scheduler.fundPayroll{value: 2 ether}();
        scheduler.fundKeeperFees{value: 0.2 ether}();
        scheduler.setKeeperRewardAmount(0.05 ether);

        actor.executeDuePayments(scheduler);

        (
            uint256 payrollReserved,
            uint256 keeperFeeReserved,
            uint256 keeperRewardAmount,
            uint256 contractBalance
        ) = scheduler.getAccounting();

        assertEqUint(payrollReserved, 1 ether);
        assertEqUint(keeperFeeReserved, 0.15 ether);
        assertEqUint(keeperRewardAmount, 0.05 ether);
        assertEqUint(contractBalance, 1.15 ether);
    }

    function test_millisecondTimestampChainExecutesUsingSecondSchedule() public {
        uint256 startTime = 1_778_685_360;
        vm.warp(startTime * 1000);
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, startTime);
        scheduler.fundPayroll{value: 1 ether}();

        scheduler.executeDuePayments();

        PayrollScheduler.PaymentHistory[] memory history = scheduler.getPaymentHistory();
        assertEqUint(history.length, 1);
        assertEqUint(history[0].timestamp, startTime);
    }

    function test_millisecondTimestampChainDoesNotExecuteFutureSecondSchedule() public {
        uint256 currentTime = 1_778_685_360;
        vm.warp(currentTime * 1000);
        scheduler.addRecipient(recipient, "Alice", 1 ether, 0, currentTime + 1 hours);
        scheduler.fundPayroll{value: 1 ether}();

        try scheduler.executeDuePayments() {
            fail("future payment should not be due on millisecond timestamp chains");
        } catch {}

        assertEqUint(scheduler.getPaymentHistory().length, 0);
    }

    function assertTrue(bool value) internal pure {
        if (!value) revert("expected true");
    }

    function assertFalse(bool value) internal pure {
        if (value) revert("expected false");
    }

    function assertEqAddress(address actual, address expected) internal pure {
        if (actual != expected) revert("addresses not equal");
    }

    function assertEqUint(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert("uints not equal");
    }

    function assertEqString(string memory actual, string memory expected) internal pure {
        if (keccak256(bytes(actual)) != keccak256(bytes(expected))) revert("strings not equal");
    }

    function fail(string memory message) internal pure {
        revert(message);
    }
}
