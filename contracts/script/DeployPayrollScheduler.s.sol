// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PayrollScheduler} from "../src/PayrollScheduler.sol";

interface Vm {
    function envString(string calldata key) external view returns (string memory);
    function envOr(string calldata key, string calldata defaultValue) external view returns (string memory);
    function envUint(string calldata key) external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployPayrollScheduler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (PayrollScheduler scheduler) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        string memory name = vm.envOr("PAYROLL_NAME", "Ritual Payroll Scheduler");

        vm.startBroadcast(deployerPrivateKey);
        scheduler = new PayrollScheduler(name);
        vm.stopBroadcast();
    }
}
