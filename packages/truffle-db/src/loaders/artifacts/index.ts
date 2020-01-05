import gql from "graphql-tag";
import { TruffleDB } from "truffle-db/db";
import * as Contracts from "@truffle/workflow-compile/new";
import { ContractObject } from "@truffle/contract-schema/spec";
import * as fse from "fs-extra";
import path from "path";
import Config from "@truffle/config";
import { Environment } from "@truffle/environment";
import Web3 from "web3";

import {
  AddBytecodes,
  AddContracts,
  AddContractInstances,
  AddNetworks
} from "../queries";
import { load } from "../load";

type WorkflowCompileResult = {
  compilations: {
    [compilerName: string]: {
      sourceIndexes: Array<string>;
      contracts: Array<ContractObject>;
    };
  };
  contracts: { [contractName: string]: ContractObject };
};

type networkLinkObject = {
  [name: string]: string;
};

type LinkValueLinkReferenceObject = {
  bytecode: string;
  index: number;
};

type LinkValueObject = {
  value: string;
  linkReference: LinkValueLinkReferenceObject;
};

type LoaderNetworkObject = {
  contract: string;
  id: string;
  address: string;
  transactionHash: string;
  links?: networkLinkObject;
};

type LinkReferenceObject = {
  offsets: Array<number>;
  name: string;
  length: number;
};

type BytecodeInfo = {
  id: string;
  linkReferences: Array<LinkReferenceObject>;
  bytes?: string;
};

type BytecodesObject = {
  bytecodes: Array<BytecodeInfo>;
  callBytecodes: Array<BytecodeInfo>;
};

type IdObject = {
  id: string;
};

type CompilationConfigObject = {
  contracts_directory?: string;
  contracts_build_directory?: string;
  artifacts_directory?: string;
  working_directory?: string;
  all?: boolean;
};

export class ArtifactsLoader {
  private db: TruffleDB;
  private config: object;

  constructor(db: TruffleDB, config?: CompilationConfigObject) {
    this.db = db;
    this.config = config;
  }

  async load(): Promise<void> {
    const result = await Contracts.compile(this.config);

    const { compilations } = await load(this.db, result);

    //map contracts and contract instances to compiler
    await Promise.all(
      compilations.map(async ({ compiler, id }) => {
        const networks = await this.loadNetworks(
          result.compilations[compiler.name].contracts,
          this.config["artifacts_directory"],
          this.config["contracts_directory"]
        );

        const contractIds = await this.loadCompilationContracts(
          result.compilations[compiler.name].contracts,
          id,
          compiler.name,
          networks
        );

        if (networks[0].length) {
          this.loadContractInstances(
            result.compilations[compiler.name].contracts,
            contractIds.contractIds,
            networks,
            contractIds.bytecodes
          );
        }
      })
    );
  }

  async loadCompilationContracts(
    contracts: Array<ContractObject>,
    compilationId: string,
    compilerName: string,
    networks: Array<any>
  ) {
    const bytecodes = await this.loadBytecodes(contracts);

    const contractObjects = contracts.map((contract, index) => {
      let createBytecodeLinkValues;
      let network = networks[index].filter(
        network => network.contract == contract["contractName"]
      );

      const createBytecode = bytecodes.bytecodes[index];
      const callBytecode = bytecodes.callBytecodes[index];

      let contractObject = {
        name: contract["contractName"],
        abi: {
          json: JSON.stringify(contract["abi"])
        },
        compilation: {
          id: compilationId
        },
        sourceContract: {
          index: index
        },
        createBytecode: {
          id: createBytecode.id
        },
        callBytecode: {
          id: callBytecode.id
        }
      };

      return contractObject;
    });

    const contractsLoaded = await this.db.query(AddContracts, {
      contracts: contractObjects
    });

    const contractIds = contractsLoaded.data.workspace.contractsAdd.contracts.map(
      ({ id }) => ({ id })
    );

    return {
      compilerName: contracts[0].compiler.name,
      contractIds: contractIds,
      bytecodes: bytecodes
    };
  }

  async loadBytecodes(
    contracts: Array<ContractObject>
  ): Promise<BytecodesObject> {
    // transform contract objects into data model bytecode inputs
    // and run mutation
    let bytecodes = [];
    let deployedBytecodes = [];
    contracts.map(({ deployedBytecode, bytecode }) => {
      bytecodes.push(bytecode);
      deployedBytecodes.push(deployedBytecode);
    });

    const createBytecodeResult = await this.db.query(AddBytecodes, {
      bytecodes: bytecodes
    });
    const callBytecodeResult = await this.db.query(AddBytecodes, {
      bytecodes: deployedBytecodes
    });

    return {
      bytecodes: createBytecodeResult.data.workspace.bytecodesAdd.bytecodes,
      callBytecodes: callBytecodeResult.data.workspace.bytecodesAdd.bytecodes
    };
  }

  async loadNetworks(
    contracts: Array<ContractObject>,
    artifacts: string,
    workingDirectory: string
  ) {
    const networksByContract = await Promise.all(
      contracts.map(async ({ contractName, bytecode }) => {
        const name = contractName.toString().concat(".json");
        const artifactsNetworksPath = fse.readFileSync(
          path.join(artifacts, name)
        );
        const artifactsNetworks = JSON.parse(artifactsNetworksPath.toString())
          .networks;
        let configNetworks = [];
        if (Object.keys(artifactsNetworks).length) {
          const config = Config.detect({ workingDirectory: workingDirectory });
          for (let network of Object.keys(config.networks)) {
            config.network = network;
            await Environment.detect(config);
            let networkId;
            let web3;
            try {
              web3 = new Web3(config.provider);
              networkId = await web3.eth.net.getId();
            } catch (err) {}

            if (networkId) {
              let filteredNetwork = Object.entries(artifactsNetworks).filter(
                network => network[0] == networkId
              );
              //assume length of filteredNetwork is 1 -- shouldn't have multiple networks with same id in one contract
              if (filteredNetwork.length > 0) {
                const transaction = await web3.eth.getTransaction(
                  filteredNetwork[0][1]["transactionHash"]
                );
                const historicBlock = {
                  height: transaction.blockNumber,
                  hash: transaction.blockHash
                };

                const networksAdd = await this.db.query(AddNetworks, {
                  networks: [
                    {
                      name: network,
                      networkId: networkId,
                      historicBlock: historicBlock
                    }
                  ]
                });

                const id =
                  networksAdd.data.workspace.networksAdd.networks[0].id;
                configNetworks.push({
                  contract: contractName,
                  id: id,
                  address: filteredNetwork[0][1]["address"],
                  transactionHash: filteredNetwork[0][1]["transactionHash"],
                  bytecode: bytecode,
                  links: filteredNetwork[0][1]["links"]
                });
              }
            }
          }
        }
        return configNetworks;
      })
    );
    return networksByContract;
  }

  getNetworkLinks(network: LoaderNetworkObject, bytecode: BytecodeInfo) {
    let networkLink: Array<LinkValueObject> = [];
    if (network.links) {
      networkLink = Object.entries(network.links).map(link => {
        let linkReferenceIndexByName = bytecode.linkReferences.findIndex(
          ({ name }) => name === link[0]
        );

        let linkValue = {
          value: link[1],
          linkReference: {
            bytecode: bytecode.id,
            index: linkReferenceIndexByName
          }
        };

        return linkValue;
      });
    }

    return networkLink;
  }

  async loadContractInstances(
    contracts: Array<ContractObject>,
    contractIds: Array<IdObject>,
    networksArray: Array<Array<LoaderNetworkObject>>,
    bytecodes: BytecodesObject
  ) {
    // networksArray is an array of arrays of networks for each contract;
    // this first mapping maps to each contract
    const instances = networksArray.map((networks, index) => {
      // this second mapping maps each network in a contract
      const contractInstancesByNetwork = networks.map(network => {
        let createBytecodeLinkValues = this.getNetworkLinks(
          network,
          bytecodes.bytecodes[index]
        );
        let callBytecodeLinkValues = this.getNetworkLinks(
          network,
          bytecodes.callBytecodes[index]
        );

        let instance = {
          address: network.address,
          contract: contractIds[index],
          network: {
            id: network.id
          },
          creation: {
            transactionHash: network.transactionHash,
            constructor: {
              createBytecode: {
                bytecode: { id: bytecodes.bytecodes[index].id },
                linkValues: createBytecodeLinkValues
              }
            }
          },
          callBytecode: {
            bytecode: { id: bytecodes.callBytecodes[index].id },
            linkValues: callBytecodeLinkValues
          }
        };
        return instance;
      });

      return contractInstancesByNetwork;
    });

    await this.db.query(AddContractInstances, {
      contractInstances: instances.flat()
    });
  }
}
