import debugModule from "debug";
const debug = debugModule("decoder:contract");

import * as CodecUtils from "truffle-codec-utils";
import { Types, Values, wrapElementaryViaDefinition, Contexts } from "truffle-codec-utils";
import AsyncEventEmitter from "async-eventemitter";
import Web3 from "web3";
import { ContractObject } from "@truffle/contract-schema/spec";
import BN from "bn.js";
import { Definition as DefinitionUtils, AbiUtils, EVM, AstDefinition, AstReferences } from "truffle-codec-utils";
import TruffleWireDecoder from "./wire";
import { BlockType, Transaction } from "web3/eth/types";
import { Log } from "web3/types";
import { Provider } from "web3/providers";
import * as Codec from "truffle-codec";
import * as DecoderTypes from "./types";
import * as Utils from "./utils";

export default class TruffleContractDecoder extends AsyncEventEmitter {

  private web3: Web3;

  private contexts: Contexts.DecoderContexts;

  private contract: ContractObject;
  private contractNode: AstDefinition;
  private contractNetwork: string;
  private context: Contexts.DecoderContext;
  private constructorContext: Contexts.DecoderContext;
  private contextHash: string;
  private constructorContextHash: string;

  private allocations: Codec.AllocationInfo;
  private stateVariableReferences: Codec.StorageMemberAllocation[];

  private wireDecoder: TruffleWireDecoder;

  constructor(contract: ContractObject, wireDecoder: TruffleWireDecoder, address?: string) {
    super();

    this.contract = contract;
    this.wireDecoder = wireDecoder;
    this.web3 = wireDecoder.getWeb3();

    this.contexts = wireDecoder.getContexts().byHash;

    this.contractNode = Utils.getContractNode(this.contract);
    if(this.contractNode === undefined) {
      throw new DecoderTypes.ContractBeingDecodedHasNoNodeError();
    }

    if(this.contract.deployedBytecode && this.contract.deployedBytecode !== "0x") {
      const hash = CodecUtils.Conversion.toHexString(
        CodecUtils.EVM.keccak256({type: "string",
          value: this.contract.deployedBytecode
        })
      );
      this.contextHash = hash;
      this.context = this.contexts[hash];
    }
    if(this.contract.bytecode && this.contract.bytecode !== "0x") { //now the constructor version
      const hash = CodecUtils.Conversion.toHexString(
        CodecUtils.EVM.keccak256({type: "string",
          value: this.contract.bytecode
        })
      );
      this.constructorContextHash = hash;
      this.constructorContext = this.contexts[hash];
    }

    this.allocations = {};
    this.allocations.abi = this.wireDecoder.getAbiAllocations();
    this.allocations.storage = Codec.getStorageAllocations(
      this.wireDecoder.getReferenceDeclarations(),
      {[this.contractNode.id]: this.contractNode}
    );

    debug("done with allocation");
    this.stateVariableReferences = this.allocations.storage[this.contractNode.id].members;
    debug("stateVariableReferences %O", this.stateVariableReferences);
  }

  public async init(): Promise<void> {
    this.contractNetwork = (await this.web3.eth.net.getId()).toString();
  }

  public async forInstance(address?: string): Promise<TruffleContractInstanceDecoder> {
    let instanceDecoder = new TruffleContractInstanceDecoder(this, address);
    await instanceDecoder.init();
    return instanceDecoder;
  }

  public async decodeTransaction(transaction: Transaction): Promise<DecoderTypes.DecodedTransaction> {
    return await this.wireDecoder.decodeTransaction(transaction);
  }

  public async decodeLog(log: Log): Promise<DecoderTypes.DecodedLog> {
    return await this.wireDecoder.decodeLog(log);
  }

  public async decodeLogs(logs: Log[]): Promise<DecoderTypes.DecodedLog[]> {
    return await this.wireDecoder.decodeLogs(logs);
  }

  public async events(options: DecoderTypes.EventOptions = {}): Promise<DecoderTypes.DecodedLog[]> {
    return await this.wireDecoder.events(options);
  }

  //the following functions are for internal use
  public getAllocations() {
    return this.allocations;
  }

  public getStateVariableReferences() {
    return this.stateVariableReferences;
  }

  public getWireDecoder() {
    return this.wireDecoder;
  }

  public getContractInfo(): ContractInfo {
    return {
      contract: this.contract,
      contractNode: this.contractNode,
      contractNetwork: this.contractNetwork,
      context: this.context,
      constructorContext: this.constructorContext,
      contextHash: this.contextHash,
      constructorContextHash: this.constructorContextHash
    }
  }
}

interface ContractInfo {
  contract: ContractObject;
  contractNode: AstDefinition;
  contractNetwork: string;
  context: Contexts.DecoderContext;
  constructorContext: Contexts.DecoderContext;
  contextHash: string;
  constructorContextHash: string;
}

export class TruffleContractInstanceDecoder extends AsyncEventEmitter {
  private web3: Web3;

  private contract: ContractObject;
  private contractNode: AstDefinition;
  private contractNetwork: string;
  private contractAddress: string;
  private contractCode: string;
  private context: Contexts.DecoderContext;
  private constructorContext: Contexts.DecoderContext;
  private contextHash: string;
  private constructorContextHash: string;

  private contexts: Contexts.DecoderContexts = {};
  private contextsById: Contexts.DecoderContextsById = {}; //deployed contexts only
  private constructorContextsById: Contexts.DecoderContextsById = {};
  private additionalContexts: Contexts.DecoderContextsById = {}; //for passing to wire decoder when contract has no deployedBytecode

  private referenceDeclarations: AstReferences;
  private userDefinedTypes: Types.TypesById;
  private allocations: Codec.AllocationInfo;

  private stateVariableReferences: Codec.StorageMemberAllocation[];

  private mappingKeys: Codec.Slot[] = [];

  private storageCache: DecoderTypes.StorageCache = {};

  private contractDecoder: TruffleContractDecoder;
  private wireDecoder: TruffleWireDecoder;

  constructor(contractDecoder: TruffleContractDecoder, address?: string) {
    super();

    this.contractDecoder = contractDecoder;
    if(address !== undefined) {
      this.contractAddress = address;
    }
    this.wireDecoder = this.contractDecoder.getWireDecoder();
    this.web3 = this.wireDecoder.getWeb3();

    this.referenceDeclarations = this.wireDecoder.getReferenceDeclarations();
    this.userDefinedTypes = this.wireDecoder.getUserDefinedTypes();
    ({ byHash: this.contexts, byId: this.contextsById, constructorsById: this.constructorContextsById } = this.wireDecoder.getContexts());
    ({
      contract: this.contract,
      contractNode: this.contractNode,
      contractNetwork: this.contractNetwork,
      context: this.context,
      constructorContext: this.constructorContext,
      contextHash: this.contextHash,
      constructorContextHash: this.constructorContextHash
    } = this.contractDecoder.getContractInfo());

    this.allocations = this.contractDecoder.getAllocations();
    this.stateVariableReferences = this.contractDecoder.getStateVariableReferences();

    if(this.contractAddress === undefined) {
      this.contractAddress = this.contract.networks[this.contractNetwork].address;
    }
  }

  public async init(): Promise<void> {
    this.contractCode = CodecUtils.Conversion.toHexString(
      await this.getCode(this.contractAddress, await this.web3.eth.getBlockNumber())
    );

    if(!this.contract.deployedBytecode || this.contract.deployedBytecode === "0x") {
      //if this contract does *not* have the deployedBytecode field, then the decoder core
      //has no way of knowing that contracts or function pointers with its address
      //are of its class; this is an especial problem for function pointers, as it
      //won't be able to determine what the selector points to.
      //so, to get around this, we make an "additional context" for the contract,
      //based on its *actual* deployed bytecode as pulled from the blockchain.
      //This way the decoder core can recognize the address as the class, without us having
      //to make serious modifications to contract decoding.  And while sure this requires
      //a little more work, I mean, it's all cached, so, no big deal.
      let extraContext = Utils.makeContext(this.contract, this.contractNode);
      //now override the binary
      extraContext.binary = this.contractCode;
      this.additionalContexts = {[extraContext.contractId]: extraContext};
      //the following line only has any effect if we're dealing with a library,
      //since the code we pulled from the blockchain obviously does not have unresolved link references!
      //(it's not strictly necessary even then, but, hey, why not?)
      this.additionalContexts = <Contexts.DecoderContextsById>Contexts.normalizeContexts(this.additionalContexts);
      //again, since the code did not have unresolved link references, it is safe to just
      //mash these together like I'm about to
      this.contextsById = {...this.contextsById, ...this.additionalContexts};
    }
  }

  private async decodeVariable(variable: Codec.StorageMemberAllocation, block: number): Promise<Values.Result> {
    const info: Codec.EvmInfo = {
      state: {
        storage: {},
      },
      mappingKeys: this.mappingKeys,
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: this.contextsById,
      currentContext: this.context
    };

    const decoder = Codec.decodeVariable(variable.definition, variable.pointer, info);

    let result = decoder.next();
    while(!result.done) {
      let request = <Codec.DecoderRequest>(result.value);
      let response: Uint8Array;
      if(Codec.isStorageRequest(request)) {
        response = await this.getStorage(this.contractAddress, request.slot, block);
      }
      else if(Codec.isCodeRequest(request)) {
        response = await this.getCode(request.address, block);
      }
      //note: one of the above conditionals *must* be true by the type system.
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value

    return <Values.Result>result.value;
  }

  public async state(block: BlockType = "latest"): Promise<DecoderTypes.ContractState | undefined> {
    let blockNumber = typeof block === "number"
      ? block
      : (await this.web3.eth.getBlock(block)).number;

    let result: DecoderTypes.ContractState = {
      name: this.contract.contractName,
      code: this.contractCode,
      balanceAsBN: new BN(await this.web3.eth.getBalance(this.contractAddress, blockNumber)),
      nonceAsBN: new BN(await this.web3.eth.getTransactionCount(this.contractAddress, blockNumber)),
      variables: {}
    };

    debug("state called");

    for(const variable of this.stateVariableReferences) {

      debug("about to decode %s", variable.definition.name);
      const decodedVariable = await this.decodeVariable(variable, blockNumber);
      debug("decoded");

      result.variables[variable.definition.name] = decodedVariable;

      debug("var %O", result.variables[variable.definition.name]);
    }

    return result;
  }

  public async variable(nameOrId: string | number, block: BlockType = "latest"): Promise<Values.Result | undefined> {
    let blockNumber = typeof block === "number"
      ? block
      : (await this.web3.eth.getBlock(block)).number;

    let variable: Codec.StorageMemberAllocation;
    variable = this.stateVariableReferences.find(
      ({definition}) => definition.name === nameOrId || definition.id == nameOrId
    ); //there should be exactly one
    //note: deliberate use of == in that second one to allow numeric strings to work

    if(variable === undefined) { //if user put in a bad name
      return undefined;
    }

    return await this.decodeVariable(variable, blockNumber);
  }

  private async getStorage(address: string, slot: BN, block: number): Promise<Uint8Array> {
    //first, set up any preliminary layers as needed
    if(this.storageCache[block] === undefined) {
      this.storageCache[block] = {};
    }
    if(this.storageCache[block][address] === undefined) {
      this.storageCache[block][address] = {};
    }
    //now, if we have it cached, just return it
    if(this.storageCache[block][address][slot.toString()] !== undefined) {
      return this.storageCache[block][address][slot.toString()];
    }
    //otherwise, get it, cache it, and return it
    let word = CodecUtils.Conversion.toBytes(
      await this.web3.eth.getStorageAt(
        address,
        slot,
        block
      ),
      CodecUtils.EVM.WORD_SIZE
    );
    this.storageCache[block][address][slot.toString()] = word;
    return word;
  }

  private async getCode(address: string, block: number): Promise<Uint8Array> {
    return await this.wireDecoder.getCode(address, block);
  }

  //EXAMPLE: to watch a.b.c[d][e], use watchMappingKey("a", "b", "c", d, e)
  //(this will watch all ancestors too, or at least ones given by mapping keys)
  //feel free to mix arrays, mappings, and structs here!
  //see the comment on constructSlot for more detail on what forms are accepted
  public watchMappingKey(variable: number | string, ...indices: any[]): void {
    let slot: Codec.Slot | undefined = this.constructSlot(variable, ...indices)[0];
    //add mapping key and all ancestors
    debug("slot: %O", slot);
    while(slot !== undefined &&
      this.mappingKeys.every(existingSlot =>
      !Codec.equalSlots(existingSlot,slot)
        //we put the newness requirement in the while condition rather than a
        //separate if because if we hit one ancestor that's not new, the futher
        //ones won't be either
    )) {
      if(slot.key !== undefined) { //only add mapping keys
          this.mappingKeys = [...this.mappingKeys, slot];
      }
      slot = slot.path;
    }
  }

  //input is similar to watchMappingKey; will unwatch all descendants too
  public unwatchMappingKey(variable: number | string, ...indices: any[]): void {
    let slot: Codec.Slot | undefined = this.constructSlot(variable, ...indices)[0];
    if(slot === undefined) {
      return; //not strictly necessary, but may as well
    }
    //remove mapping key and all descendants
    this.mappingKeys = this.mappingKeys.filter( existingSlot => {
      while(existingSlot !== undefined) {
        if(Codec.equalSlots(existingSlot, slot)) {
          return false; //if it matches, remove it
        }
        existingSlot = existingSlot.path;
      }
      return true; //if we didn't match, keep the key
    });
  }
  //NOTE: if you decide to add a way to remove a mapping key *without* removing
  //all descendants, you'll need to alter watchMappingKey to use an if rather
  //than a while

  public async decodeTransaction(transaction: Transaction): Promise<DecoderTypes.DecodedTransaction> {
    return await this.wireDecoder.decodeTransaction(transaction, this.additionalContexts);
  }

  public async decodeLog(log: Log): Promise<DecoderTypes.DecodedLog> {
    return await this.wireDecoder.decodeLog(log, {}, this.additionalContexts);
  }

  public async decodeLogs(logs: Log[]): Promise<DecoderTypes.DecodedLog[]> {
    return await this.wireDecoder.decodeLogs(logs, {}, this.additionalContexts);
  }

  //note: by default restricts address to address of this
  //contract, but you can override this (including by specifying
  //address undefined to not filter by adddress)
  public async events(options: DecoderTypes.EventOptions = {}): Promise<DecoderTypes.DecodedLog[]> {
    return await this.wireDecoder.events({address: this.contractAddress, ...options}, this.additionalContexts);
  }

  public onEvent(name: string, callback: Function): void {
    //this.web3.eth.subscribe(name);
  }

  public removeEventListener(name: string): void {
  }

  //in addition to returning the slot we want, it also returns a definition
  //used in the recursive call
  //HOW TO USE:
  //variable may be either a variable id (number or numeric string) or name (string)
  //struct members may be given either by id (number) or name (string)
  //array indices and numeric mapping keys may be BN, number, or numeric string
  //string mapping keys should be given as strings. duh.
  //bytes mapping keys should be given as hex strings beginning with "0x"
  //address mapping keys are like bytes; checksum case is not required
  //boolean mapping keys may be given either as booleans, or as string "true" or "false"
  private constructSlot(variable: number | string, ...indices: any[]): [Codec.Slot | undefined , AstDefinition | undefined] {
    //base case: we need to locate the variable and its definition
    if(indices.length === 0) {
      let allocation: Codec.StorageMemberAllocation;
      allocation = this.stateVariableReferences.find(
        ({definition}) => definition.name === variable || definition.id == variable
      ); //there should be exactly one
      //note: deliberate use of == in that second one to allow numeric strings to work

      let definition = allocation.definition;
      let pointer = allocation.pointer;
      if(pointer.location !== "storage") { //i.e., if it's a constant
        return [undefined, undefined];
      }
      return [pointer.range.from.slot, definition];
    }

    //main case
    let parentIndices = indices.slice(0, -1); //remove last index
    let [parentSlot, parentDefinition] = this.constructSlot(variable, ...parentIndices);
    if(parentSlot === undefined) {
      return [undefined, undefined];
    }
    let rawIndex = indices[indices.length - 1];
    let index: any;
    let key: Values.ElementaryValue;
    let slot: Codec.Slot;
    let definition: AstDefinition;
    switch(DefinitionUtils.typeClass(parentDefinition)) {
      case "array":
        if(rawIndex instanceof BN) {
          index = rawIndex.clone();
        }
        else {
          index = new BN(rawIndex);
        }
        definition = parentDefinition.baseType || parentDefinition.typeName.baseType;
        let size = Codec.storageSize(definition, this.referenceDeclarations, this.allocations.storage);
        if(!Codec.isWordsLength(size)) {
          return [undefined, undefined];
        }
        slot = {
          path: parentSlot,
          offset: index.muln(size.words),
          hashPath: DefinitionUtils.isDynamicArray(parentDefinition)
        }
        break;
      case "mapping":
        let keyDefinition = parentDefinition.keyType || parentDefinition.typeName.keyType;
        key = wrapElementaryViaDefinition(rawIndex, keyDefinition);
        definition = parentDefinition.valueType || parentDefinition.typeName.valueType;
        slot = {
          path: parentSlot,
          key,
          offset: new BN(0)
        }
        break;
      case "struct":
        let parentId = DefinitionUtils.typeId(parentDefinition);
        let allocation: Codec.StorageMemberAllocation;
        if(typeof rawIndex === "number") {
          index = rawIndex;
          allocation = this.allocations.storage[parentId].members[index];
          definition = allocation.definition;
        }
        else {
          allocation = Object.values(this.allocations.storage[parentId].members)
          .find(({definition}) => definition.name === rawIndex); //there should be exactly one
          definition = allocation.definition;
          index = definition.id; //not really necessary, but may as well
        }
        slot = {
          path: parentSlot,
          //need type coercion here -- we know structs don't contain constants but the compiler doesn't
          offset: (<Codec.StoragePointer>allocation.pointer).range.from.slot.offset.clone()
        }
        break;
      default:
        return [undefined, undefined];
    }
    return [slot, definition];
  }

}
