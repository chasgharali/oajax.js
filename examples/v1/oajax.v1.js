var ref_cache = '';
var ref_request = '';

var $off_ajax = $.ajax;

(function($){

var $oajax = $.ajax;


$.ajax = function(o){
	
	
	
	if(o.data){
		var Data = JSON.stringify(o.data) ;
		ref_cache = "cache@" + o.url + "%" + Data ;
		ref_request = "request@" + o.url + "%" + Data ;
	}
	else {
		ref_cache = "cache@" + o.url ;
		ref_request = "request@" + o.url ;
	}
	
	
	
     if (o.error) {
		var originalErrorHandler2 = o.success;
		var errorHandlerContext2 = o.context ? o.context : $;
		var customError2Handler = function(result) {
		    result = JSON.parse("{ \"error\" : 404 }");
			
		if (localStorage.getItem(ref_cache) === null) {
            if(localStorage.getItem(ref_request) === null){
				var ajaxState = JSON.stringify(o);
				window.localStorage.setItem(ref_request , ajaxState);
				sync_que =  oajax.getQue();
				sync_que.push(ref_request);
				window.localStorage.setItem("sync_que" , JSON.stringify(sync_que));
			}
		}
        
		else{
				 
		    if(oajax.logMsg)
                console.log("getting data offline");
                
			var data = localStorage.getItem(ref_cache);
				
				if(oajax.parseResult){
					result = JSON.parse(data);
				}
				else{
					result = data;
				}
				
        }
			
			
			originalErrorHandler2.apply(errorHandlerContext2, arguments);
        
        };

        // override error callback with custom implementation           
        o.error = customError2Handler;
    };
	
	
	if(o.success){
		var originalErrorHandler = o.success;
		var errorHandlerContext = o.context ? o.context : $;
        var customErrorHandler = function(result) {
			window.localStorage.setItem(ref_cache , JSON.stringify(result) );
             if(oajax.logMsg)
			  console.log("getting data online");
            
			originalErrorHandler.apply(errorHandlerContext, arguments);
        };
		o.success = customErrorHandler;
	}
	

    $oajax.apply($, arguments);
};

})(jQuery);

var $oajax = $.ajax;





var oajax ={
   
  parseResult : true,
  logMsg :true ,
  
  getQue : function(){
    if (localStorage.getItem("sync_que") === null) {
        window.localStorage.setItem("sync_que" , JSON.stringify([]));
        return [];     
    }
    else{
        var que =localStorage.getItem("sync_que");
         return JSON.parse(que);
    }

  },

  queHandle : function(){
    sync_que =  oajax.getQue();
      
      var i = 0;
		for(; i < sync_que.length ; ++i ){
         
         oajax.syncData(sync_que[i], function(e){
			 console.log(e);
			if(e=="success"){
			 sync_que.splice(i , 1);
			 //localStorage.setItem("sync_que" , JSON.stringify(sync_que));
			}
		   
           
         });
        
         
    }
    window.localStorage.setItem("sync_que" , JSON.stringify(sync_que));
  },
 
 
  syncData : function(handler , callback){
    
	var Request = JSON.parse(localStorage.getItem(handler));
	
	if(Request.data){
		var Data = JSON.stringify(Request.data) ;
		ref_cache = "cache@" + Request.url + "%" + Data ;
	}
	else {
		ref_cache = "cache@" + Request.url ;
	}
	
	
	
	Request.async = false;
	Request.success = function(data){
				
				 window.localStorage.setItem(ref_cache, JSON.stringify(data) );
				
                 if(oajax.logMsg)
				console.log(handler +": "+ Request.url + " sync with server");
                localStorage.removeItem(handler);
				callback("success");
            };
	Request.error = function (request, status, error){
				 callback("error");
            };
	
	
	
	
	$off_ajax(Request);
  
  }



} ;




$(document).ready ( function(){
  var SyncInterval = 10 * 1000;

  window.setInterval(function(){
          oajax.queHandle();
          
  }, SyncInterval);

});
